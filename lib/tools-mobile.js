/**
 * MobileRE tools — the mobile reverse-engineering layer.
 *
 * REA's Android surface is static: it reads classes, methods and resources out
 * of an APK. It cannot show you what an app does while it runs. MobileRE is the
 * other half — Frida hooks, unpacking, anti-injection probes, DEX recovery, SO
 * analysis, Unicorn emulation — and its scripts are Python, so they arrive here
 * as subprocesses rather than MCP tools.
 *
 * Design notes:
 *
 *  - **Grouped, not 1:1.** Twenty-one scripts would be twenty-one tools the
 *    model has to choose between. Each tool here is one job, and the script
 *    that does it is an implementation detail.
 *  - **The interpreter is discovered, not assumed.** `python` on Windows is
 *    often the Microsoft Store stub, which exits 49 and prints a help link. The
 *    probe skips that and reports the real reason.
 *  - **UTF-8 is forced.** Every script prints Chinese; the Windows console
 *    default is GBK, and mis-decoded output is worse than no output because it
 *    reads as data corruption.
 *  - **Missing dependencies are named.** A script that needs `frida` says so
 *    before it runs, instead of failing with an ImportError traceback.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = path.join(HERE, '..', 'vendor', 'mobilere');
const TOOLS = path.join(VENDOR, 'tools');
const REFERENCES = path.join(VENDOR, 'references');

/** Seconds a tool may run before it is killed. Frida sessions need minutes. */
const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * Script → Python packages it imports beyond the standard library.
 *
 * Kept here rather than parsed at runtime: a missing module is the single most
 * common failure, and an explicit table lets the tool say which package to
 * install instead of surfacing an ImportError from inside the script.
 */
const SCRIPT_REQUIREMENTS = {
  'frida_run.py': ['frida'],
  'unpack.py': ['frida'],
  'so.py': ['capstone', 'elftools'],
  'emu_run.py': ['unicorn', 'capstone'],
  'uniharness.py': ['unicorn', 'capstone'],
};

/** pip name for an import name, where they differ. */
const PIP_NAMES = {
  elftools: 'pyelftools',
  z3: 'z3-solver',
};

/**
 * Find a usable Python 3.
 *
 * Order matters: an explicitly configured path wins, then PATH, then the
 * per-user install location Windows uses when the Store stub owns `python`.
 * The Store stub is rejected because it exits 49 with a help link rather than
 * running anything — treating it as Python produces a confusing failure.
 */
export function findPython(configured = null) {
  const candidates = [];
  if (configured) candidates.push(configured);

  if (process.platform === 'win32') {
    candidates.push('python.exe', 'python3.exe', 'py.exe');
  } else {
    candidates.push('python3', 'python');
  }

  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  if (process.platform === 'win32' && home) {
    for (const version of ['Python313', 'Python312', 'Python311', 'Python310']) {
      candidates.push(path.join(home, 'AppData', 'Local', 'Programs', 'Python', version, 'python.exe'));
    }
  }

  for (const candidate of candidates) {
    if (path.isAbsolute(candidate)) {
      if (existsSync(candidate)) return candidate;
      continue;
    }
    // On Windows a bare name resolves to the Microsoft Store stub, which exits
    // 49 and prints a help link. Only the per-user install path is trustworthy,
    // so bare names are skipped there and the absolute candidates above win.
    if (process.platform === 'win32') continue;
    return candidate;
  }
  return null;
}

let cachedPython = null;

/** Run the version probe once per process and memoise the result. */
function resolvePython(configured) {
  if (cachedPython) return cachedPython;

  const candidate = findPython(configured);
  if (!candidate) {
    cachedPython = { ok: false, error: '未找到 Python 3（已检查 PATH 与 %LOCALAPPDATA%\\Programs\\Python）' };
    return cachedPython;
  }
  cachedPython = { ok: true, command: candidate };
  return cachedPython;
}

/** Reset the memoised interpreter, so a settings change takes effect. */
export function resetPythonCache() {
  cachedPython = null;
}

/**
 * Probe the interpreter and the packages the vendored scripts need.
 *
 * One `python -c` invocation reports everything, because spawning Python is
 * ~100 ms on Windows and a per-module probe would make the settings page slow.
 */
export async function probePython(configured = null) {
  resetPythonCache();
  const resolved = resolvePython(configured);
  if (!resolved.ok) {
    return { present: false, version: null, missing: [], command: null, error: resolved.error };
  }

  const modules = [
    'frida', 'capstone', 'unicorn', 'lief', 'elftools', 'keystone', 'z3',
  ];

  const script = `
import sys, json
mods = ${JSON.stringify(modules)}
out = {}
for m in mods:
    try:
        __import__(m)
        out[m] = True
    except Exception:
        out[m] = False
print(json.dumps({"version": sys.version.split()[0], "modules": out}))
`;

  const result = await run(resolved.command, ['-c', script], { timeoutMs: 20_000 });
  if (result.code !== 0) {
    return {
      present: false,
      version: null,
      missing: [],
      command: resolved.command,
      error: (result.stderr || result.stdout || 'version probe failed').trim().slice(0, 300),
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout.trim().split('\n').pop());
  } catch {
    return {
      present: false,
      version: null,
      missing: [],
      command: resolved.command,
      error: '无法解析 Python 版本探测输出',
    };
  }

  const missing = Object.entries(parsed.modules).filter(([, ok]) => !ok).map(([name]) => name);

  return {
    present: true,
    version: parsed.version,
    modules: parsed.modules,
    missing,
    command: resolved.command,
  };
}

/**
 * Spawn a process and collect stdout/stderr.
 *
 * Not `exec`: the tool output is the payload, and a shell would rewrite it.
 * On Windows a `.py` file needs the interpreter as argv[0], which the caller
 * supplies; only the `.bat` helper needs a shell.
 */
function run(command, args, { cwd = TOOLS, timeoutMs = DEFAULT_TIMEOUT_MS, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: command.endsWith('.bat'),
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      try { child.kill(); } catch { /* already gone */ }
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}\n${error.message}`, killed });
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, killed });
    });
  });
}

/**
 * Run one vendored script and flatten the result for the Host tool channel.
 *
 * A non-zero exit is an error, but its stderr is the interesting part: these
 * scripts report "device not found", "no frida server", "invalid ELF" there.
 */
async function runScript(scriptName, args, { timeoutMs, python } = {}) {
  const scriptPath = path.join(TOOLS, scriptName);
  if (!existsSync(scriptPath)) {
    throw new Error(`MobileRE 脚本缺失：${scriptName}（vendor/mobilere/tools 不完整）`);
  }

  const resolved = resolvePython(python);
  if (!resolved.ok) throw new Error(resolved.error);

  const required = SCRIPT_REQUIREMENTS[scriptName] ?? [];
  if (required.length > 0) {
    const probe = await probePython(python);
    const absent = required.filter((name) => probe.modules?.[name] === false);
    if (absent.length > 0) {
      const pipNames = absent.map((name) => PIP_NAMES[name] ?? name);
      throw new Error(
        `缺少 Python 依赖：${absent.join(', ')}。`
        + `安装命令：${probe.command} -m pip install ${pipNames.join(' ')}`,
      );
    }
  }

  const result = await run(resolved.command, [scriptPath, ...args], { timeoutMs });

  if (result.killed) {
    throw new Error(`${scriptName} 超时（${Math.round((timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)}s）已终止`);
  }

  const text = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n\n');

  if (result.code !== 0) {
    throw new Error(`${scriptName} 退出码 ${result.code}：\n${text || '(无输出)'}`);
  }

  return text || '(脚本无输出)';
}

/** A read-only reference doc, so the model can pull the method behind a tool. */
function readReference(name) {
  const file = path.join(REFERENCES, name);
  if (!existsSync(file)) return null;
  return readFileSync(file, 'utf8');
}

/**
 * Build the MobileRE tools.
 *
 * Five tools, grouped by job. `python` comes from plugin config so an operator
 * with a specific interpreter can point at it.
 */
export function buildMobileTools(config = {}) {
  const python = config.pythonPath ?? null;
  const baseTimeout = Number(config.mobileToolTimeoutMs ?? DEFAULT_TIMEOUT_MS);

  return [
    {
      name: 'mobile_unpack',
      description:
        'Android 脱壳：从 APK 或运行中的进程提取 DEX，去重并重建。'
        + '支持壳检测、内存 dump、DEX 合并。用于处理加固/加壳的 Android 应用。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['detect', 'dump', 'dedupe', 'rebuild'],
            description: 'detect=识别壳类型；dump=从设备内存提取 DEX；dedupe=去重；rebuild=重建 APK',
          },
          target: {
            type: 'string',
            description: 'APK 路径（detect/dedupe/rebuild）或 Android 包名（dump）',
          },
          output: {
            type: 'string',
            description: '输出目录，缺省为 target 同级的 unpacked/ 目录',
          },
          serial: {
            type: 'string',
            description: 'adb 设备序列号，多设备时必填',
          },
        },
        required: ['action', 'target'],
      },
      async execute(args = {}) {
        const action = String(args.action ?? 'detect');
        const target = String(args.target ?? '');
        if (!target) throw new Error('target 不能为空');

        if (action === 'dedupe') {
          const argv = [target];
          if (args.output) argv.push('--output', String(args.output));
          return runScript('dex_dedupe.py', argv, { timeoutMs: baseTimeout, python });
        }
        if (action === 'rebuild') {
          const argv = [target];
          if (args.output) argv.push('--output', String(args.output));
          return runScript('dex_rebuilder.py', argv, { timeoutMs: baseTimeout, python });
        }
        // unpack.py handles both detect and dump.
        const argv = [action, target];
        if (args.output) argv.push('--output', String(args.output));
        if (args.serial) argv.push('--serial', String(args.serial));
        return runScript('unpack.py', argv, { timeoutMs: baseTimeout, python });
      },
    },

    {
      name: 'mobile_frida',
      description:
        'Frida 动态插桩：在 Android/iOS 应用运行时执行 hook 脚本、绕过反调试、'
        + '追踪加密函数、dump 内存。用于观察应用的运行时行为。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['run', 'list-devices', 'list-processes', 'modules'],
            description: 'run=执行脚本；list-devices=枚举设备；list-processes=枚举进程；modules=列出已加载模块',
          },
          script: {
            type: 'string',
            description: 'action=run 时要执行的 JS 脚本路径，或 vendor 内置模块名（如 bypass/anti-debug）',
          },
          target: {
            type: 'string',
            description: '包名或进程名（action=run / modules）',
          },
          serial: {
            type: 'string',
            description: '目标设备序列号',
          },
          duration: {
            type: 'number',
            description: '运行秒数，缺省 30',
          },
        },
        required: ['action'],
      },
      async execute(args = {}) {
        const action = String(args.action ?? 'run');
        const argv = [action];
        if (args.script) argv.push('--script', String(args.script));
        if (args.target) argv.push('--target', String(args.target));
        if (args.serial) argv.push('--serial', String(args.serial));
        if (args.duration) argv.push('--duration', String(args.duration));
        return runScript('frida_run.py', argv, { timeoutMs: baseTimeout, python });
      },
    },

    {
      name: 'mobile_check',
      description:
        'Android 安全检测：反注入/反调试能力探测、Janus 漏洞检查、'
        + '应用加固特征识别。用于评估目标应用的分析难度。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['anti-inject', 'janus', 'apk-info'],
            description: 'anti-inject=反注入能力；janus=Janus 漏洞（CVE-2017-13156）；apk-info=APK 元信息',
          },
          target: {
            type: 'string',
            description: 'APK 路径或包名',
          },
        },
        required: ['action', 'target'],
      },
      async execute(args = {}) {
        const action = String(args.action ?? 'anti-inject');
        const target = String(args.target ?? '');
        if (!target) throw new Error('target 不能为空');

        if (action === 'apk-info') {
          const resolved = resolvePython(python);
          if (!resolved.ok) throw new Error(resolved.error);
          // GetAPKInfo.jar needs Java, not Python; run it through the JDK.
          const java = process.env.JAVA_HOME
            ? path.join(process.env.JAVA_HOME, 'bin', 'java.exe')
            : 'java';
          const result = await run(java, ['-jar', path.join(TOOLS, 'GetAPKInfo.jar'), target], {
            timeoutMs: baseTimeout,
          });
          const text = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n\n');
          if (result.code !== 0) throw new Error(`GetAPKInfo 退出码 ${result.code}：\n${text}`);
          return text || '(无输出)';
        }

        if (action === 'janus') {
          return runScript('janus_check.py', [target], { timeoutMs: baseTimeout, python });
        }
        return runScript('check-anti-inject.py', [target], { timeoutMs: baseTimeout, python });
      },
    },

    {
      name: 'mobile_so',
      description:
        'Native SO 静态分析：ELF 结构、符号表、字符串、交叉引用、反汇编、'
        + 'JNI 函数判型。用于分析 Android 应用的 native 层。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['info', 'strings', 'dump', 'disasm', 'strref', 'callers', 'svc', 'jni'],
            description: 'info=ELF 侦察（段/节/依赖/符号）；strings=字符串枚举；dump=按地址读字节；disasm=快速反汇编；strref=反查字符串引用；callers=反查调用者；svc=内联 SVC 扫描；jni=JNI 调用点判型',
          },
          target: {
            type: 'string',
            description: '.so / ELF 文件路径',
          },
          filter: {
            type: 'string',
            description: 'action=strings/info 时的 grep 过滤关键词',
          },
          offset: {
            type: 'string',
            description: 'action=info 时要换算的虚址（如 0x1234）',
          },
        },
        required: ['action', 'target'],
      },
      async execute(args = {}) {
        const action = String(args.action ?? 'info');
        const target = String(args.target ?? '');
        if (!target) throw new Error('target 不能为空');

        // so.py takes the subcommand first, then the path, then its own flags.
        const argv = [action, target];
        if (args.filter) argv.push('--grep', String(args.filter));
        if (args.offset) argv.push('--v2o', String(args.offset));
        return runScript('so.py', argv, { timeoutMs: baseTimeout, python });
      },
    },

    {
      name: 'mobile_emulate',
      description:
        'Unicorn 指令级模拟：在隔离环境执行 SO 里的单个函数，追踪寄存器/内存、'
        + '还原算法、解密数据，不需要真机或完整程序。支持 JNI 环境桩与 syscall 拦截。',
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description: '.so 文件路径',
          },
          symbol: {
            type: 'string',
            description: '要模拟的函数名（与 offset 二选一）',
          },
          offset: {
            type: 'string',
            description: '函数偏移或虚拟地址（与 symbol 二选一，如 0x1a20）',
          },
          args: {
            type: 'string',
            description: '传参，逗号分隔（十六进制或十进制，字符串用 \'文本\'）',
          },
          jni: {
            type: 'boolean',
            description: '启用 JNI 环境桩，模拟 JNIEnv 调用',
          },
          trace: {
            type: 'boolean',
            description: '输出指令级执行追踪',
          },
          read: {
            type: 'string',
            description: '执行后读取内存（格式：地址:长度，如 0x4000:64）',
          },
          poke: {
            type: 'string',
            description: '执行前写入内存（格式：地址=十六进制字节，如 0x4000=deadbeef）',
          },
          timeout: {
            type: 'number',
            description: '模拟超时秒数，缺省 30',
          },
        },
        required: ['target'],
      },
      async execute(args = {}) {
        const target = String(args.target ?? '');
        if (!target) throw new Error('target 不能为空');
        if (!args.symbol && !args.offset) {
          throw new Error('必须提供 symbol 或 offset 之一来指定入口');
        }

        // emu_run.py takes the SO path first, then flags; there is no action
        // subcommand, so the mode is inferred from the flags supplied.
        const argv = [target];
        if (args.symbol) argv.push('--sym', String(args.symbol));
        if (args.offset) argv.push('--off', String(args.offset));
        if (args.args) argv.push('--args', String(args.args));
        if (args.jni) argv.push('--jni');
        if (args.trace) argv.push('--trace');
        if (args.read) argv.push('--read', String(args.read));
        if (args.poke) argv.push('--poke', String(args.poke));
        if (args.timeout) argv.push('--timeout', String(args.timeout));

        return runScript('emu_run.py', argv, { timeoutMs: baseTimeout, python });
      },
    },

    {
      name: 'mobile_reference',
      description:
        '读取 MobileRE 实战手册：反检测、脱壳、加密 hook、行为分析、'
        + 'native 分析、静态分析、排错指南、Frida API 参考。',
      parameters: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            enum: [
              'index', 'anti-detection', 'unpacking', 'crypto-hook',
              'behavior-analysis', 'static-analysis', 'native-analysis',
              'troubleshooting', 'api-reference',
            ],
            description: 'index 是总索引，会告诉你该读哪一篇',
          },
        },
        required: ['topic'],
      },
      async execute(args = {}) {
        const topic = String(args.topic ?? 'index');
        const file = topic === 'index' ? '_index.md' : `${topic}.md`;
        const text = readReference(file);
        if (text === null) {
          throw new Error(`手册不存在：${topic}。可用：见 mobile_reference 的 topic 枚举`);
        }
        return text;
      },
    },
  ];
}

/** Exposed for the health check: how many scripts and docs are actually present. */
export function vendorInventory() {
  const tools = existsSync(TOOLS) ? readDirSafe(TOOLS) : [];
  const docs = existsSync(REFERENCES) ? readDirSafe(REFERENCES) : [];
  return {
    root: VENDOR,
    toolCount: tools.filter((name) => name.endsWith('.py') || name.endsWith('.jar') || name.endsWith('.bat')).length,
    docCount: docs.filter((name) => name.endsWith('.md')).length,
    present: tools.length > 0,
  };
}

function readDirSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

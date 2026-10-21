/**
 * Service health for the workbench overview.
 *
 * The panel cannot see inside the MCP client, so this module answers the
 * question from the outside: are the `mcp__rea__*` tools actually registered in
 * this process, and how many? A registered tool means the stdio server started,
 * completed the MCP handshake, and answered `tools/list`. A missing one means
 * the launch failed — wrong Node version, `npx` blocked, package resolution
 * error — and the panel must say so instead of showing a green "ready".
 *
 * Every check returns a status plus a remediation line, because "MCP 断开" alone
 * leaves the user with nothing to do.
 */

import { probeAll, providerEnvironment, CACHE_ROOT, REA_AGENTS_VERSION } from './providers.js';

/** Minimum Node version REA accepts, matching its `engines.node` field. */
const NODE_RULES = [
  { matches: (major) => major === 22, minMinor: 19 },
  { matches: (major) => major === 24, minMinor: 11 },
  { matches: (major) => major >= 26, minMinor: 0 },
];

function checkNode() {
  const version = process.versions.node;
  const [majorText, minorText] = version.split('.');
  const major = Number(majorText);
  const minor = Number(minorText);

  const rule = NODE_RULES.find((candidate) => candidate.matches(major));
  const ok = Boolean(rule) && minor >= rule.minMinor;

  return {
    id: 'node',
    label: 'Node.js',
    // `ok` drives the dot; `warn` marks a condition that limits features but
    // does not stop the server.
    status: ok ? 'ok' : 'error',
    value: `v${version}`,
    detail: ok
      ? null
      : `REA 需要 Node 22.19+ / 24.11+ / 26+，当前 v${version} 无法启动 MCP 服务`,
    fix: ok ? null : '升级 Node.js 到 22.19 或更高版本，然后重启 Harness',
  };
}

/**
 * Inspect registered tools for the REA server.
 *
 * `ctx.tools.schemas()` is the same projection the model sees, so counting
 * `mcp__rea__` there proves the agent can actually call them.
 */
function checkMcpTools(tools) {
  let schemas = [];
  try {
    schemas = tools?.schemas ? tools.schemas() : [];
  } catch {
    schemas = [];
  }

  const reaTools = schemas.filter((schema) => String(schema?.name ?? '').startsWith('mcp__rea__'));
  const count = reaTools.length;

  if (count === 0) {
    return {
      id: 'mcp',
      label: 'REA MCP 服务',
      status: 'error',
      value: '未连接',
      detail: '没有任何 mcp__rea__* 工具注册在进程里，说明 stdio 服务器没有起来或握手失败',
      fix: '检查 Harness 日志中的 rea-mcp 行；常见原因是 Node 版本、npx 被拦截、或首次下载超时',
      toolCount: 0,
    };
  }

  return {
    id: 'mcp',
    label: 'REA MCP 服务',
    // The upstream catalogue is 207 tools. Fewer than half means a partial
    // connection or a different server answered, which warrants a warning even
    // though calls may still work.
    status: count >= 100 ? 'ok' : 'warn',
    value: `${count} 个工具`,
    detail: count >= 100
      ? null
      : `只注册了 ${count} 个工具，低于完整的 207 个；可能是部分工具被限制或版本不符`,
    fix: count >= 100 ? null : '重新加载 rea-mcp 行以重建工具目录',
    toolCount: count,
  };
}

/** Java is a hard prerequisite for JADX and apktool. */
function checkJava(java) {
  return {
    id: 'java',
    label: 'Java 运行时',
    status: java?.present ? 'ok' : 'warn',
    value: java?.present ? String(java.version ?? '已安装').slice(0, 40) : '缺失',
    detail: java?.present ? null : 'JADX 与 apktool 依赖 Java，缺失时 Android 分析不可用',
    fix: java?.present ? null : '安装 JDK 17+ 并确保 java 在 PATH 中',
  };
}

/**
 * Python runtime for the MobileRE layer.
 *
 * Missing packages are reported by name rather than as a single failure: the
 * thirteen standard-library scripts still work, so this is a partial capability
 * (warn), never a hard error.
 */
function checkPython(python) {
  if (!python) {
    return {
      id: 'python',
      label: 'Python 运行时',
      status: 'warn',
      value: '未探测',
      detail: 'MobileRE 的 21 个脚本需要 Python 3.9+',
      fix: '安装 Python 3 后刷新；插件会自动发现 %LOCALAPPDATA%\Programs\Python',
    };
  }
  if (!python.present) {
    return {
      id: 'python',
      label: 'Python 运行时',
      status: 'warn',
      value: '缺失',
      detail: python.error ?? 'MobileRE 的 21 个脚本需要 Python 3.9+',
      fix: '安装 Python 3.11+，或用 config.pythonPath 指定解释器路径',
    };
  }

  const missing = python.missing ?? [];
  const core = missing.filter((name) => ['frida', 'capstone', 'elftools'].includes(name));
  const optional = missing.filter((name) => !core.includes(name));

  if (missing.length === 0) {
    return {
      id: 'python',
      label: 'Python 运行时',
      status: 'ok',
      value: python.version,
      detail: 'MobileRE 全部脚本可用',
      fix: null,
    };
  }

  const pip = missing
    .map((name) => (name === 'elftools' ? 'pyelftools' : (name === 'z3' ? 'z3-solver' : name)))
    .join(' ');

  return {
    id: 'python',
    label: 'Python 运行时',
    status: 'warn',
    value: `${python.version} · 缺 ${missing.length} 包`,
    detail: `未安装：${missing.join(', ')}。纯标准库脚本仍可用`,
    fix: `${python.command} -m pip install ${pip}`,
  };
}

/** Engine summary as one line. */
function checkEngines(providers, java) {
  const ready = providers.filter((provider) => provider.present);
  const required = providers.filter((provider) => !provider.advisory);

  // JADX without Java cannot decompile, so a present jar with no runtime is not
  // "ready" in any useful sense.
  const blockedByJava = !java?.present && ready.some((provider) => provider.id === 'jadx');
  const readyCount = ready.length;
  const totalCount = providers.length;

  const status = blockedByJava
    ? 'warn'
    : readyCount === totalCount
      ? 'ok'
      : readyCount === 0
        ? 'error'
        : 'warn';

  return {
    id: 'engines',
    label: '分析引擎',
    status,
    value: `${readyCount} / ${totalCount}`,
    detail: blockedByJava
      ? 'JADX 已安装但缺少 Java，无法反编译'
      : readyCount === totalCount
        ? null
        : `未安装：${providers.filter((provider) => !provider.present).map((provider) => provider.title).join(', ')}`,
    fix: readyCount === totalCount ? null : '在工作台下方的引擎卡片上点击「一键安装」',
    readyCount,
    totalCount,
  };
}

/** Where engines live, plus whether that path is writable. */
async function checkCache(cacheRoot) {
  try {
    const fs = await import('node:fs/promises');
    await fs.mkdir(cacheRoot, { recursive: true });
    const probe = `${cacheRoot}/.write-probe`;
    await fs.writeFile(probe, 'ok');
    await fs.rm(probe, { force: true });
    return {
      id: 'cache',
      label: '引擎目录',
      status: 'ok',
      value: cacheRoot,
      detail: null,
      fix: null,
    };
  } catch (error) {
    return {
      id: 'cache',
      label: '引擎目录',
      status: 'error',
      value: cacheRoot,
      detail: `目录不可写：${error.message}`,
      fix: '检查磁盘空间与目录权限，或把引擎装到其他位置后手动设置环境变量',
    };
  }
}

/**
 * Full service-health report.
 *
 * Returned as a list so the panel renders one row per check without knowing the
 * order or the set of checks in advance.
 */
export async function buildHealth({ tools, telemetry, python = null }) {
  const report = await probeAll();

  const checks = [
    checkNode(),
    checkMcpTools(tools),
    checkEngines(report.providers, report.java),
    checkJava(report.java),
    checkPython(python),
    await checkCache(CACHE_ROOT),
  ];

  const counts = telemetry?.counts ?? { total: 0, failed: 0, rea: 0, reaFailed: 0 };
  const recentFailureRate = counts.total > 0 ? counts.failed / counts.total : 0;

  checks.push({
    id: 'errors',
    label: '近期错误',
    // A high failure rate matters more than an absolute count: one failure among
    // three calls is far worse than five among two hundred.
    status: recentFailureRate > 0.25 ? 'error' : recentFailureRate > 0.05 ? 'warn' : 'ok',
    value: `${counts.failed} / ${counts.total}`,
    detail: counts.failed > 0
      ? `自启动以来 ${counts.total} 次调用中有 ${counts.failed} 次失败`
      : null,
    fix: counts.failed > 0 ? '展开下方「错误聚合」查看具体工具与原因' : null,
  });

  const worst = checks.some((check) => check.status === 'error')
    ? 'error'
    : checks.some((check) => check.status === 'warn')
      ? 'warn'
      : 'ok';

  return {
    ok: worst !== 'error',
    overall: worst,
    at: Date.now(),
    uptimeMs: Date.now() - (telemetry?.startedAt ?? Date.now()),
    checks,
    environment: providerEnvironment(),
    reaVersion: REA_AGENTS_VERSION,
    cacheRoot: CACHE_ROOT,
    platform: `${process.platform}/${process.arch}`,
  };
}

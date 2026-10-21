/**
 * The `rea` CLI, wrapped as one Host tool.
 *
 * Why a CLI tool at all when the MCP bridge already exposes 207 tools: cost.
 * Every MCP tool ships its full JSON Schema into the prompt, and a single
 * `tools/list` result is tens of thousands of tokens. The CLI is a thin command
 * surface over the same engine with two properties an agent wants:
 *
 *   --format json       machine-readable output instead of prose
 *   --filter-output     project only the keys that matter, so a 40 KB Evidence
 *                       bundle becomes the 400 bytes the question needed
 *
 * So this is a *budget* tool, not a replacement: the MCP path stays for
 * interactive multi-step work, and this one is for a single question answered
 * cheaply. It is also the only path that can read `--llms`, the manifest REA
 * publishes specifically for models.
 */

import { spawn } from 'node:child_process';

/** How long a CLI call may run. Ghidra analysis is the slow end. */
const DEFAULT_TIMEOUT_MS = 600_000;

/**
 * Commands safe to expose as a free-form string.
 *
 * A whitelist rather than "anything the CLI accepts": the argument becomes part
 * of a command line, and a typo should fail here rather than inside a spawned
 * process with unexpected flags.
 */
const SAFE_COMMAND = /^[a-z][a-z0-9-]*$/;

/** Strip anything that could break out of the argv array. */
function assertCommand(command) {
  if (!SAFE_COMMAND.test(command)) {
    throw new Error(`非法的 rea 子命令：${command}（只允许小写字母、数字和连字符）`);
  }
  return command;
}

/**
 * Run `rea <args>` and return stdout.
 *
 * Arguments are passed as an argv array with no shell, so a path containing
 * spaces or quotes is a value, never a second command.
 */
function runRea(args, { timeoutMs = DEFAULT_TIMEOUT_MS, cwd, signal } = {}) {
  return new Promise((resolve, reject) => {
    const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const fullArgs = ['-y', `rea-agents@${runRea.version ?? '6.7.0'}`, ...args];

    const child = spawn(command, fullArgs, {
      cwd,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // npx is a .cmd shim on Windows and needs a shell to resolve.
      shell: process.platform === 'win32',
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      try { child.kill(); } catch { /* already gone */ }
    }, timeoutMs);

    const onAbort = () => {
      killed = true;
      try { child.kill(); } catch { /* already gone */ }
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    child.on('error', (error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new Error(`无法启动 rea CLI：${error.message}`));
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (killed) {
        reject(new Error(`rea ${args[0] ?? ''} 超时（${Math.round(timeoutMs / 1000)}s）已终止`));
        return;
      }
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * Build the CLI tool.
 *
 * One tool with a `command` argument rather than 155 separate tools: the CLI is
 * discoverable through `--llms`, and 155 schemas in the prompt would cost more
 * than the MCP bridge it is meant to save.
 */
export function buildCliTool(config = {}) {
  const defaultTimeout = Number(config.cliTimeoutMs ?? DEFAULT_TIMEOUT_MS);

  return {
    name: 'rea_cli',
    description:
      'Run the rea CLI directly. Cheaper than the MCP tools for a single question: '
      + 'use --format json for machine output and --filter-output to keep only the keys you need. '
      + 'Discover commands with action=commands, and read the full agent manifest with action=manifest. '
      + 'Every command from the MCP surface is available here; prefer this when the answer is one call '
      + 'deep and the full Evidence envelope is not needed.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['run', 'commands', 'manifest', 'schema'],
          description:
            'run=执行子命令；commands=列出全部命令（轻量）；'
            + 'manifest=打印完整 LLM 清单（--llms，含每个命令的参数）；'
            + 'schema=查某个命令的 JSON Schema',
        },
        command: {
          type: 'string',
          description: 'action=run 时要执行的 rea 子命令，如 analyze、inspect_native_load_image',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description:
            '子命令的参数数组，按 CLI 顺序原样传递。'
            + '例：["E:/sample.exe", "--format", "json"]',
        },
        format: {
          type: 'string',
          enum: ['json', 'toon', 'yaml', 'md', 'jsonl'],
          description: '输出格式（默认由 CLI 决定；json 最省 token 且易解析）',
        },
        filter: {
          type: 'string',
          description:
            '只保留指定键路径，逗号分隔。例："identity,pseudocode"，'
            + '可大幅减少输出体积',
        },
        tokenLimit: {
          type: 'number',
          description: '限制输出 token 数（CLI 的 --token-limit）',
        },
        timeoutMs: {
          type: 'number',
          description: '超时毫秒数，缺省 600000（10 分钟，Ghidra 分析可能很慢）',
        },
      },
      required: ['action'],
    },
    async execute(input = {}) {
      const action = String(input.action ?? 'run');

      if (action === 'commands') {
        const result = await runRea(['--help'], { timeoutMs: 60_000 });
        const commands = [...result.stdout.matchAll(/^ {2}([a-z][a-z0-9-]+)\s{2,}/gm)]
          .map((m) => m[1]);
        return `${commands.length} 个命令：\n\n${commands.join('\n')}`;
      }

      if (action === 'manifest') {
        const result = await runRea(['--llms'], { timeoutMs: 60_000 });
        if (result.code !== 0) throw new Error(result.stderr || 'rea --llms 失败');
        return result.stdout;
      }

      if (action === 'schema') {
        const target = String(input.command ?? '');
        if (!target) throw new Error('action=schema 需要 command 参数');
        const result = await runRea([assertCommand(target), '--schema'], { timeoutMs: 60_000 });
        if (result.code !== 0) throw new Error(result.stderr || `rea ${target} --schema 失败`);
        return result.stdout;
      }

      // action === 'run'
      const target = String(input.command ?? '');
      if (!target) throw new Error('action=run 需要 command 参数');

      const argv = [assertCommand(target)];

      // Spread caller args verbatim; they are values, not shell words.
      if (Array.isArray(input.args)) {
        for (const value of input.args) argv.push(String(value));
      }

      if (input.format) argv.push('--format', String(input.format));
      if (input.filter) argv.push('--filter-output', String(input.filter));
      if (input.tokenLimit) argv.push('--token-limit', String(input.tokenLimit));

      const timeoutMs = Number(input.timeoutMs ?? defaultTimeout);
      const result = await runRea(argv, { timeoutMs });

      if (result.code !== 0) {
        const detail = (result.stderr || result.stdout || '').trim();
        throw new Error(`rea ${target} 退出码 ${result.code}${detail ? `：\n${detail.slice(0, 1500)}` : ''}`);
      }

      return result.stdout.trim() || '(命令无输出)';
    },
  };
}

/** Let the factory pin the upstream version without a second config path. */
export function setCliVersion(version) {
  runRea.version = version;
}

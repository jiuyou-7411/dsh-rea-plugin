/**
 * One REA tool, two backends, routed per command.
 *
 * The plugin used to expose REA two ways and ask the operator to pick:
 *
 *   - 207 MCP tools — exact schemas, but 59,551 tokens of definitions in every
 *     request whether or not the session touches reverse engineering.
 *   - a CLI escape hatch — zero schema cost, but the model guesses argument
 *     names and burns turns on `COMMAND_NOT_FOUND`.
 *
 * Neither is right, and a config switch between them is not a solution: the
 * operator should not have to trade coverage for cost. So this registers ONE
 * tool and decides per call:
 *
 *   - The command exists in the CLI (141 commands, stateless, takes a path
 *     directly) → run the CLI. No target to open first, parallel-safe, and the
 *     tool definition costs nothing.
 *   - It does not (99 tools: Hopper GUI operations, `compare_*` variants, the
 *     reconstruction ledger, Frida/GDB/Rizin sessions) → call the MCP server,
 *     which is where those live and where their state belongs.
 *
 * Matching is exact after snake_case → kebab-case, with no alias table. An alias
 * (`analyze_function` → `function`) would also have to translate arguments, and
 * a wrong translation is worse than paying for the MCP schema on those calls.
 *
 * The second half of the fusion is the error path. REA's CLI already reports
 * structured failures — `COMMAND_NOT_FOUND`, and `VALIDATION_ERROR` naming the
 * exact missing field. Their distribution responds to a bad call by telling the
 * model to go run `rea --help`, which costs two more round trips. This tool runs
 * the help itself and returns the usage block with the error, so one wrong call
 * is enough to correct it.
 */

import { runRea } from './tool-cli.js';

const DEFAULT_TIMEOUT_MS = 600_000;
const HELP_TIMEOUT_MS = 30_000;

/** Cache: the CLI command list changes only when the pinned version changes. */
let cliCommands = null;

/**
 * The CLI's command list, fetched once.
 *
 * Parsed from `rea --help` rather than hardcoded: the pinned upstream version is
 * a config value, and a hardcoded list would silently go stale the first time
 * someone bumps it.
 */
async function loadCliCommands() {
  if (cliCommands) return cliCommands;
  const result = await runRea(['--help'], { timeoutMs: HELP_TIMEOUT_MS });
  const names = [...result.stdout.matchAll(/^ {2}([a-z][a-z0-9-]+)\s{2,}/gm)].map((m) => m[1]);
  cliCommands = new Set(names);
  return cliCommands;
}

/**
 * Whether this command can run on the stateless CLI.
 *
 * Exact kebab-case match only. Deliberately no aliases — see the module comment.
 */
function cliNameFor(command, commands) {
  const kebab = String(command ?? '').trim().replace(/_/g, '-');
  return commands.has(kebab) ? kebab : null;
}

/** Turn the structured CLI failure into something the model can act on. */
function describeCliFailure(command, result) {
  const text = `${result.stdout}\n${result.stderr}`.trim();
  const codeMatch = text.match(/code:\s*([A-Z_]+)/);
  const code = codeMatch?.[1] ?? null;

  if (code === 'COMMAND_NOT_FOUND') {
    return `命令不存在：rea 没有 \`${command}\` 这条子命令。`;
  }
  if (code === 'VALIDATION_ERROR') {
    const fields = [...text.matchAll(/"path":\s*\[\s*"([^"]+)"/g)].map((m) => m[1]);
    const missing = [...new Set(fields)];
    return missing.length
      ? `参数不合法：缺少或类型错误 ${missing.join('、')}。`
      : '参数不合法，见下方用法。';
  }
  return `rea ${command} 退出码 ${result.code}。`;
}

/**
 * Build the unified REA tool.
 *
 * `getMcp` returns the live MCP client (or null before the bridge is ready) and
 * `getMcpTools` its tool-name set — both are lazy because the tool is registered
 * before the connection finishes.
 */
export function buildReaTool({ getMcp, getMcpTools, reaVersion, defaultTimeoutMs } = {}) {
  const defaultTimeout = Number(defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS);

  return {
    name: 'rea',
    description:
      'REA 逆向分析的唯一入口。命令自动路由：有命令行实现的走无状态 CLI，'
      + '其余走 MCP，你不用关心走哪条。\n\n'
      + '常用命令（按目标类型）：\n'
      + '· 原生 exe/so/elf → analyze <路径> 总览，再 function / decompile / xrefs / search 聚焦\n'
      + '· Android APK → inspect-android-package → search-android-classes → '
      + 'inspect-android-class → inspect-android-method\n'
      + '· JavaScript/Electron → analyze-javascript-application <目录>\n'
      + '· 归档/包（ZIP/APK/IPA/DMG）→ inspect-artifact，要落地用 extract-artifact\n'
      + '· .NET → inspect-managed-artifact；固件 → inspect-firmware-regions；'
      + 'WASM → inspect-wasm-artifact\n'
      + '· 先跑 doctor 看引擎是否就绪，capabilities 看各操作可用性\n\n'
      + '大结果不要读回上下文：加 format="json" 让它结构化，'
      + '用 tokenLimit 限制体积，需要完整证据时用 evidence-export 落盘。\n\n'
      + '不知道命令名时传 command="help" 拿完整清单；参数错了会连同用法一起返回。',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description:
            'REA 命令名，下划线和连字符都接受（analyze_function 与 analyze-function 等价）。'
            + '传 help 列出全部命令。',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description:
            '命令的位置参数与开关，按 CLI 顺序原样传。例：["E:/sample.exe"]。'
            + '走 MCP 的命令改用 input。',
        },
        input: {
          type: 'object',
          description:
            '走 MCP 的命令用命名参数。例：{"path":"E:/sample.exe"}。'
            + '和 args 二选一。',
          additionalProperties: true,
        },
        format: {
          type: 'string',
          enum: ['json', 'toon', 'yaml', 'md', 'jsonl'],
          description: '输出格式。json 最省 token 且易解析。',
        },
        filter: {
          type: 'string',
          description: '只保留指定键路径，逗号分隔。例："identity,pseudocode"。',
        },
        tokenLimit: {
          type: 'number',
          description: '限制输出 token 数，大输出务必带上。',
        },
        timeoutMs: {
          type: 'number',
          description: '超时毫秒数，缺省 600000。Ghidra 分析可能很慢。',
        },
      },
      required: ['command'],
    },

    async execute(raw = {}) {
      const requested = String(raw.command ?? '').trim();
      if (!requested) throw new Error('需要 command 参数。传 command="help" 查看全部命令。');

      // ── help: the discovery path ──────────────────────────────────────
      if (requested === 'help' || requested === 'commands') {
        const result = await runRea(['--help'], { timeoutMs: HELP_TIMEOUT_MS });
        return result.stdout.trim() || '(rea --help 无输出)';
      }

      const commands = await loadCliCommands();
      const cliName = cliNameFor(requested, commands);

      // ── CLI channel ───────────────────────────────────────────────────
      if (cliName) {
        if (raw.input && typeof raw.input === 'object' && Object.keys(raw.input).length > 0) {
          // Named input on a CLI command: the CLI takes positional words, so
          // say so instead of silently dropping the arguments.
          throw new Error(
            `\`${cliName}\` 走命令行，请用 args 传位置参数，不要用 input。`
            + `\n先用 command="${cliName}" 加 args=[] 试一次；参数不对会返回用法。`,
          );
        }

        const argv = [cliName];
        if (Array.isArray(raw.args)) for (const value of raw.args) argv.push(String(value));

        const format = raw.format ? String(raw.format) : null;
        if (format) argv.push('--format', format);
        if (raw.filter) argv.push('--filter-output', String(raw.filter));

        /*
         * `--token-limit` and a structured format are mutually exclusive.
         *
         * Measured: `analyze --provider ghidra --format json --token-limit 500`
         * fails with UNSUPPORTED_OUTPUT_COMBINATION — "Token windows cannot
         * preserve structured output. Remove --token-limit/--token-offset and use
         * --filter-output or command pagination."
         *
         * So when the caller asks for JSON (or any structured format) the limit is
         * dropped rather than forwarded. Silently dropping a requested limit is
         * the lesser evil here: the alternative is a hard failure on the most
         * common combination, and `filter` is the mechanism that actually bounds
         * structured output. The model is told which one to use in the tool
         * description.
         */
        const structured = format !== null && ['json', 'jsonl', 'toon', 'yaml'].includes(format);
        if (raw.tokenLimit && !structured) argv.push('--token-limit', String(raw.tokenLimit));

        const result = await runRea(argv, {
          timeoutMs: Number(raw.timeoutMs ?? defaultTimeout),
        });

        if (result.code === 0) return result.stdout.trim() || '(命令无输出)';

        /*
         * Self-correcting failure: attach the usage block.
         *
         * This is the whole point of the fusion. The upstream CLI tells the
         * caller to go run `rea --help` — two more round trips before the model
         * can retry. Running it here costs one local subprocess and turns a
         * wrong call into a corrected one.
         */
        let usage = '';
        try {
          const help = await runRea([cliName, '--help'], {
            timeoutMs: HELP_TIMEOUT_MS,
          });
          usage = help.stdout.trim();
        } catch {
          usage = '';
        }

        const reason = describeCliFailure(cliName, result);
        const detail = `${result.stdout}\n${result.stderr}`.trim();
        throw new Error(
          `${reason}\n\n`
          + (usage ? `用法：\n${usage.slice(0, 2500)}\n\n` : '')
          + (detail ? `原始输出：\n${detail.slice(0, 1200)}` : ''),
        );
      }

      // ── MCP channel ───────────────────────────────────────────────────
      const mcpTools = getMcpTools?.() ?? null;
      const mcp = getMcp?.() ?? null;

      if (mcpTools?.has(requested)) {
        if (!mcp) {
          throw new Error(
            `\`${requested}\` 只有 MCP 通道支持，但 MCP 服务还没连上。`
            + '稍等片刻重试；如果一直这样，看面板「服务状态」里的 REA 一行。',
          );
        }
        if (Array.isArray(raw.args) && raw.args.length > 0) {
          throw new Error(
            `\`${requested}\` 走 MCP，请用 input 传命名参数，不要用 args。`
            + '例：{"path":"E:/sample.exe"}',
          );
        }
        const result = await mcp.callTool(requested, raw.input ?? {}, {
          timeoutMs: Number(raw.timeoutMs ?? defaultTimeout),
        });
        const blocks = Array.isArray(result?.content) ? result.content : [];
        const text = blocks
          .filter((block) => block?.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('\n');
        if (result?.isError) throw new Error(text || `工具 ${requested} 返回错误`);
        return text || '(命令无输出)';
      }

      // ── Unknown: say so, and hand over the list ───────────────────────
      const known = [...commands].sort();
      throw new Error(
        `没有 \`${requested}\` 这条命令。\n\n`
        + `CLI 支持 ${known.length} 条：\n${known.join('\n')}\n\n`
        + '传 command="help" 可以看完整说明与参数。',
      );
    },
  };
}

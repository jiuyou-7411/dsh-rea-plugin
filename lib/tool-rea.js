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

  /*
   * REA's exit code is not a reliable signal — measured, the same invalid
   * `decompile <path>` call returned 0 in one run and 1 in another. So the JSON
   * envelope is checked before the exit code: it carries the operation, the
   * offending field and a per-issue message, which is strictly more useful than
   * "退出码 1".
   */
  const jsonError = detectJsonError(result.stdout);
  if (jsonError) return describeJsonError(command, jsonError);

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
  /*
   * A non-zero exit that printed a usage block is an argument mistake, not a
   * fault — the CLI rejected the shape before doing any work. Naming it that way
   * matters twice: the model reads "参数不对" and retries instead of concluding
   * the tool is broken, and the panel can count these separately from real
   * failures when judging health.
   */
  if (/^Usage:\s/m.test(text)) {
    return `\`${command}\` 的参数不对（不是插件故障）。按下方用法调整 args 后重试。`;
  }
  return `rea ${command} 退出码 ${result.code}。`;
}

/**
 * Cap what a single call returns.
 *
 * Why this is not optional: an `analyze` on a real application returns about a
 * megabyte of JSON, and this tool hands the CLI's stdout straight back. A result
 * that size does two bad things — it fills the context with one call, and it
 * pushes the Host into its spill path, where the result is replaced by a notice
 * message whose `content` is a plain string; the DeepSeek adapter then calls
 * `.some()` on it and the whole call fails with `content.some is not a function`.
 * That error was recorded on 6 of 8 calls in this panel's own telemetry.
 *
 * The exact number comes from the Host: `spill-policy` spills any tool result
 * above `maxInlineTokens: 12500` to a file, and that path is where the crash
 * lives. At the 3.6 chars/token this codebase uses elsewhere, 36,000 characters
 * is about 10,000 tokens — comfortably inside the inline budget with room for the
 * tokenizer being less favourable than the estimate.
 *
 * So the output is cut at a boundary the model can still read, with a notice that
 * says how big it was and what to do instead. Truncating is the lesser evil: the
 * alternative is losing the call entirely, and the guidance is what actually gets
 * the model to narrow the question.
 */
const MAX_OUTPUT_CHARS = 36_000;

function boundOutput(stdout, command) {
  const text = (stdout ?? '').trim();
  if (!text) return '(命令无输出)';
  if (text.length <= MAX_OUTPUT_CHARS) return text;

  const head = text.slice(0, MAX_OUTPUT_CHARS);
  const kb = Math.round(text.length / 1024);
  return `${head}

…（输出被截断：完整内容 ${text.length.toLocaleString()} 字符，约 ${kb} KB）

这份结果太大，不适合直接读回上下文。改用下面任一方式：
  · 加 filter 只取需要的键：rea(command="${command}", args=[...], format="json", filter="identity,pseudocode")
  · 落盘再用 inspect-analysis-view 摘要或分页：
      rea(command="${command}", args=[...], format="json") 重定向到文件，
      再 rea(command="inspect-analysis-view", args=["<文件>"], format="json")
  · 需要完整证据用 evidence-export 导出成文件`;
}

/**
 * Commands whose first positional argument is the target path.
 *
 * Every analysis command in REA is path-first, and calling one without the path
 * is the single most common first-attempt mistake — it was 3 of 8 calls in this
 * panel's own telemetry, each costing a full npx spawn (~5s) before the CLI
 * returned its usage block.
 *
 * Checking here turns that into an instant, precise message instead of a slow
 * generic failure. The list is not exhaustive: anything not named still reaches
 * the CLI and gets its usage back, which is the correct fallback for a command
 * this table has not learned yet.
 */
const PATH_FIRST = new Set([
  'analyze', 'inspect', 'decompile', 'function', 'search', 'xrefs',
  'inspect-binary-layout', 'inspect-android-package', 'inspect-android-class',
  'inspect-android-method', 'search-android-classes', 'trace-android-references',
  'analyze-javascript-application', 'analyze-web-bundle',
  'inspect-artifact', 'extract-artifact', 'inspect-managed-artifact',
  'inspect-wasm-artifact', 'inspect-firmware-regions', 'extract-firmware',
  'inspect-pe-resources', 'inspect-recorded-crash', 'inspect-evm-interface',
  'inspect-native-load-image',
  'decode-android-resources', 'inspect-electron-page', 'inspect-analysis-view',
]);

/**
 * Commands whose second positional argument is mandatory.
 *
 * The usage lines print these as optional — `decompile <path> [address]`,
 * `search <path> [pattern]` — but REA rejects the call without them:
 *
 *   decompile <path>       → missing_argument "procedure"
 *   function <path>        → missing_argument "procedure"
 *   xrefs <path>           → missing_argument "procedure"
 *   search <path>          → missing_argument "pattern"
 *   extract-firmware <p>   → missing output directory
 *
 * So the bracket is wrong and the model has no way to know. Checking here turns a
 * ~30s analysis run that ends in a rejection into an instant, specific message.
 */
const SECOND_ARG = new Map([
  ['decompile', { what: '过程名或地址', example: 'main' }],
  ['function', { what: '过程名或地址', example: 'main' }],
  ['xrefs', { what: '过程名或地址', example: 'main' }],
  ['search', { what: '要搜的文本', example: 'CreateFile' }],
  ['extract-firmware', { what: '输出目录', example: 'E:/out' }],
]);

/**
 * Detect a failure that REA reported as JSON with exit code 0.
 *
 * Measured: `decompile <path>` prints
 * `{"code":"invalid_request","details":{"issues":[{"path":["procedure"],...}]}}`
 * and exits **0**. So an exit-code check alone reports success and hands the
 * model an error envelope as if it were a result — it then reasons about a JSON
 * object that has no evidence in it.
 *
 * Returns the parsed error object when stdout is an error envelope, otherwise
 * null. A successful payload always carries `evidence_id`, which is what makes
 * this check safe: no valid result lacks it.
 */
function detectJsonError(stdout) {
  const text = (stdout ?? '').trim();
  if (!text.startsWith('{')) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.evidence_id) return null;

  if (typeof parsed.code === 'string' && parsed.code !== 'ok') {
    return parsed;
  }
  if (parsed.error && typeof parsed.error === 'object') {
    return typeof parsed.error.code === 'string' ? parsed.error : { code: 'error', message: String(parsed.error) };
  }
  if (parsed.error === true) return { code: 'error', message: parsed.message ?? '未知错误' };
  return null;
}

/** Turn an error envelope into one actionable Chinese sentence. */
function describeJsonError(command, payload) {
  const code = String(payload?.code ?? 'error');
  const issues = payload?.details?.issues ?? [];
  const fields = Array.isArray(issues)
    ? issues.map((issue) => (Array.isArray(issue?.path) ? issue.path.join('.') : null)).filter(Boolean)
    : [];
  // The per-issue message is the most specific thing REA gives us — it names the
  // value that was actually rejected, which a field path alone does not.
  const issueMessages = Array.isArray(issues)
    ? issues.map((issue) => issue?.message).filter((m) => typeof m === 'string' && m.length > 0)
    : [];

  if (code === 'invalid_request' || code === 'VALIDATION_ERROR') {
    const base = fields.length
      ? `\`${command}\` 缺少参数：${[...new Set(fields)].join('、')}`
      : `\`${command}\` 的参数不合法`;
    const detail = issueMessages.length ? `\n原因：${issueMessages[0]}` : '';
    let hint = '';
    if (fields.includes('procedure') || fields.includes('address')) {
      hint = `\n这个命令需要第二个参数——过程名或地址。例：command="${command}", args=["E:/sample.exe", "main"]`;
    } else if (issueMessages.some((m) => /procedure/i.test(m))) {
      hint = '\n过程名不存在。先跑 command="search", args=["<路径>"] 拿到真实过程名再传。';
    }
    return base + detail + hint;
  }
  if (code === 'provider_unavailable' || code === 'capability_unavailable') {
    return `\`${command}\` 需要的分析引擎当前不可用。先跑 command="doctor" 看缺哪个引擎。`;
  }
  const message = payload?.message ?? '没有错误说明';
  return `\`${command}\` 失败（${code}）：${message}`;
}

/**
 * Turn an MCP argument error into something that names the accepted fields.
 *
 * MCP-only commands carry no schema the model can see — this tool routes them
 * through the client instead of registering them. So a guessed parameter name
 * comes back as `Invalid arguments for tool list_strings: Unrecognized keys:
 * "path", "filter", "limit"`, which states what is wrong and not what is right.
 * The schema lives on the bridge, so the error can say both.
 */
function describeMcpError(command, text, schemas) {
  const schema = schemas?.get?.(command) ?? null;
  const props = schema?.properties && typeof schema.properties === 'object'
    ? Object.keys(schema.properties)
    : [];
  const required = Array.isArray(schema?.required) ? schema.required : [];

  const looksLikeArgError = /Unrecognized keys|Invalid arguments|invalid_type|VALIDATION_ERROR/i.test(text);
  if (!looksLikeArgError) return text;

  const parts = [`\`${command}\` 的参数不被接受。`];
  if (props.length) {
    parts.push(`它接受的参数：${props.slice(0, 20).join('、')}${props.length > 20 ? ' 等' : ''}`);
    if (required.length) {
      parts.push(`必填：${required.join('、')}`);
      parts.push(`例：command="${command}", input={${required.map((k) => `"${k}":"..."`).join(', ')}}`);
    }
  } else {
    parts.push('这个命令没有可读的参数表。改用 command="help" 查，或换用命令行命令（如 search）。');
  }
  parts.push(`\n原始报错：${text.slice(0, 300)}`);
  return parts.join('\n');
}

/**
 * Build the unified REA tool.
 *
 * `getMcp` returns the live MCP client (or null before the bridge is ready),
 * `getMcpTools` its tool-name set and `getMcpSchemas` its input schemas — all
 * lazy because the tool is registered before the connection finishes.
 */
export function buildReaTool({ getMcp, getMcpTools, getMcpSchemas, reaVersion, defaultTimeoutMs } = {}) {
  const defaultTimeout = Number(defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS);

  return {
    name: 'rea',
    description:
      'REA 逆向分析的唯一入口。命令自动路由：有命令行实现的走无状态 CLI，'
      + '其余走 MCP，你不用关心走哪条。\n\n'
      + '【最重要】所有命令都是**路径优先**——第一个位置参数必须是目标的绝对路径。\n'
      + '传 args=["E:/sample.exe"]，不要用 input，也不要省略路径。\n\n'
      + '常用命令签名：\n'
      + '  analyze <path>                     原生总览（先跑这个）\n'
      + '  inspect <path>                     带证据的概览\n'
      + '  decompile <path> <procedure>       反编译一段（第二个参数必填）\n'
      + '  function <path> <procedure>        分析一个完整函数（第二个参数必填）\n'
      + '  search <path> [pattern]            搜字符串或函数名\n'
      + '  xrefs <path> <procedure>           交叉引用（第二个参数必填）\n'
      + '  inspect-binary-layout <path>       Linux ELF 布局（只支持 ELF，PE 会拒绝）\n'
      + '  inspect-native-load-image <path>   加载映射与重定位（拿可用地址）\n'
      + '  inspect-android-package <path>     APK 声明与清单\n'
      + '  inspect-android-class <path>       APK 类成员\n'
      + '  inspect-android-method <path>      APK 方法反编译\n'
      + '  analyze-javascript-application <path>   JS/Electron 应用\n'
      + '  inspect-artifact <path>            归档/包成员清单\n'
      + '  extract-artifact <path>            解出归档内容\n'
      + '  inspect-managed-artifact <path>    .NET 程序集\n'
      + '  inspect-wasm-artifact <path>       WebAssembly\n'
      + '  inspect-firmware-regions <path>    固件区域\n'
      + '  extract-firmware <path> <outDir>   固件提取（第二个参数是输出目录）\n'
      + '  doctor                             环境侦察（无参数）\n'
      + '  capabilities                       各操作可用性（无参数）\n\n'
      + '按目标类型的流程：\n'
      + '· 原生 exe/so/elf → analyze → inspect-native-load-image → search → decompile / function / xrefs\n'
      + '  （decompile/function/xrefs 的地址要用加载映射里的，文件偏移会被拒绝）\n'
      + '· Android APK → inspect-android-package → inspect-android-class → inspect-android-method\n'
      + '· JS/Electron → analyze-javascript-application <目录>\n'
      + '· 归档/包（ZIP/APK/IPA/DMG）→ inspect-artifact，要落地用 extract-artifact\n\n'
      + '大结果不要读回上下文：加 format="json" 结构化，用 filter 只取需要的键，'
      + '需要完整证据用 evidence-export 落盘。超过约 36k 字符会被截断。\n\n'
      + '不知道命令名时传 command="help" 拿完整清单；参数错了会连同该命令的用法一起返回。',
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
            + `\n例：command="${cliName}", args=["E:/sample.exe"]`,
          );
        }

        /*
         * Path check before spawning.
         *
         * Without this, a call that forgot the path still pays a full npx spawn
         * (~5s) and comes back with a usage block the model has to read and retry
         * from. The check costs nothing and names the exact missing argument.
         */
        if (PATH_FIRST.has(cliName)) {
          const first = Array.isArray(raw.args) ? raw.args[0] : undefined;
          const looksLikePath = typeof first === 'string'
            && first.length > 0
            && !first.startsWith('-');
          if (!looksLikePath) {
            throw new Error(
              `\`${cliName}\` 需要目标路径作为第一个参数。\n`
              + `例：command="${cliName}", args=["E:/sample.exe"]\n\n`
              + `如果路径里有空格，作为一个 args 元素整串传入即可，不要拆开。`,
            );
          }
          // Some commands also need a second positional argument.
          const second = SECOND_ARG.get(cliName);
          if (second) {
            const value = Array.isArray(raw.args) ? raw.args[1] : undefined;
            const hasValue = typeof value === 'string' && value.length > 0 && !value.startsWith('-');
            if (!hasValue) {
              throw new Error(
                `\`${cliName}\` 还需要第二个参数：${second.what}。`
                + `（用法里写成 [..] 看起来可选，实际必填）\n`
                + `例：command="${cliName}", args=["E:/sample.exe", "${second.example}"]\n`
                + (second.what.includes('过程名')
                  ? '不知道过程名时，先用 command="search", args=["<路径>", "<关键字>"] 查。'
                  : ''),
              );
            }
          }
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

        if (result.code === 0) {
          /*
           * Exit 0 does not mean success here. REA reports argument problems as a
           * JSON error envelope with a zero exit code, so this check is what keeps
           * the model from receiving an error object as a result.
           */
          const jsonError = detectJsonError(result.stdout);
          if (jsonError) throw new Error(describeJsonError(cliName, jsonError));
          return boundOutput(result.stdout, cliName);
        }

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
        if (result?.isError) {
          throw new Error(describeMcpError(requested, text || '工具返回错误', getMcpSchemas?.() ?? null));
        }
        return boundOutput(text, requested);
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

/**
 * A minimal MCP client, in-process.
 *
 * Why this exists: the workbench ships a `rea-mcp` row that expects
 * `@deepseek-ai/dsh-mcp-client` to be installed in the profile. A profile that
 * does not have it (or has one whose nine exact-version peers disagree) starts
 * that row, fails, and — because `failOnStartupError` is false — reports
 * nothing. The panel then shows "0 tools" with no way to fix it from the UI.
 *
 * So the plugin speaks the protocol itself. The subset needed is small and
 * stable: JSON-RPC 2.0 over stdio, `initialize`, `notifications/initialized`,
 * `tools/list` and `tools/call`. Everything here is observable — a failure
 * produces a message the workbench can render, which is the actual point.
 *
 * Deliberately NOT implemented: prompts, resources, completions, sampling,
 * roots. REA exposes tools; the rest would be dead code.
 */

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

/** Protocol revision this client speaks. Servers negotiate down if needed. */
const PROTOCOL_VERSION = '2024-11-05';

/** How long a `initialize` + `tools/list` bootstrap may take. */
const BOOTSTRAP_TIMEOUT_MS = 120_000;

/** Cap on one response line, so a runaway server cannot exhaust memory. */
const MAX_LINE_BYTES = 64 * 1024 * 1024;

class McpError extends Error {
  constructor(message, { code = null, data = null } = {}) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    this.data = data;
  }
}

/**
 * One long-lived MCP server process.
 *
 * Events:
 *   'state'  { state, detail }   lifecycle transitions the UI can render
 *   'log'    { level, text }     stderr lines from the server
 *   'tools'  { tools }           the tool list after (re)connect
 */
export class McpClient extends EventEmitter {
  constructor({ command, args = [], env = {}, cwd, name = 'rea' }) {
    super();
    this.command = command;
    this.args = args;
    this.env = env;
    this.cwd = cwd;
    this.serverName = name;

    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.tools = [];

    /** idle | starting | ready | error | stopped */
    this.state = 'idle';
    this.error = null;
    this.serverInfo = null;

    this.stderrTail = [];
    this.restarts = 0;

    /**
     * Backoff schedule in milliseconds: five attempts over about 52 s.
     *
     * A cold `npx rea-agents` download on a slow link can take 30 s; a machine
     * that is briefly offline recovers in seconds. This covers both without
     * keeping a genuinely broken install spinning forever.
     */
    this.retryDelaysMs = [2000, 5000, 10000, 15000, 20000];
    // A deliberate stop must not be reported as an unexpected exit.
    this.stopping = false;
  }

  #setState(state, detail = null) {
    this.state = state;
    if (state === 'error') this.error = detail;
    this.emit('state', { state, detail, serverInfo: this.serverInfo });
  }

  /**
   * Spawn, handshake, and pull the tool list. Resolves once ready.
   *
   * Retries on its own: the first run downloads rea-agents through npx, and a
   * cold registry hit fails for reasons that resolve themselves. A terminal
   * error — no interpreter, a spawn failure that cannot change — stops early
   * instead of burning forty-five seconds on retries that cannot succeed.
   */
  async start() {
    if (this.state === 'starting' || this.state === 'ready') return this.tools;

    const delays = this.retryDelaysMs;
    let lastError = null;

    for (let attempt = 0; attempt <= delays.length; attempt += 1) {
      const label = attempt === 0 ? '首次连接' : `第 ${attempt + 1} 次尝试`;
      this.#setState('starting', `${label}：正在启动 rea-agents`);

      try {
        await this.#spawn();
        await this.#handshake();
        this.tools = await this.#listTools();
        this.restarts = attempt;
        this.#setState('ready');
        this.emit('tools', { tools: this.tools });
        return this.tools;
      } catch (error) {
        lastError = error instanceof McpError
          ? error
          : new McpError(error?.message ?? String(error));
        this.#kill();

        // A spawn failure with no interpreter will not fix itself.
        if (lastError.code === 'spawn') break;
        if (attempt >= delays.length) break;

        const wait = delays[attempt];
        // A sub-second backoff would round to "0 秒", which reads as a bug.
        const waitLabel = wait < 1000 ? `${wait} 毫秒` : `${Math.round(wait / 1000)} 秒`;
        this.#setState(
          'starting',
          `${label}失败，${waitLabel}后自动重试（${lastError.message.slice(0, 80)}）`,
        );
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }

    const message = lastError?.message ?? '未知错误';
    this.#setState('error', message);
    throw lastError ?? new McpError(message);
  }

  #spawn() {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(this.command, this.args, {
          cwd: this.cwd,
          env: { ...process.env, ...this.env },
          stdio: ['pipe', 'pipe', 'pipe'],
          // `npx` is a .cmd shim on Windows; without a shell it ENOENTs.
          shell: process.platform === 'win32',
          windowsHide: true,
        });
      } catch (error) {
        reject(new McpError(
          `无法启动 MCP 进程（${this.command}）：${error.message}`, { code: 'spawn' },
        ));
        return;
      }

      this.child = child;

      const failEarly = (error) => {
        reject(new McpError(
          `MCP 进程启动失败：${error.message}`, { code: 'spawn' },
        ));
      };
      child.once('error', failEarly);

      child.once('spawn', () => {
        child.off('error', failEarly);
        child.on('error', (error) => {
          this.emit('log', { level: 'error', text: error.message });
        });
        resolve();
      });

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => this.#onStdout(chunk));

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => this.#onStderr(chunk));

      child.on('exit', (code, signal) => {
        const wasReady = this.state === 'ready';
        // Reject anything still waiting: its answer will never arrive.
        for (const [, entry] of this.pending) {
          entry.reject(new McpError(
            `MCP 进程已退出（code=${code ?? 'null'}, signal=${signal ?? 'none'}）`,
            { code: 'exit' },
          ));
        }
        this.pending.clear();
        this.child = null;

        if (this.stopping) return;
        if (this.state !== 'error') {
          this.#setState(
            'stopped',
            wasReady
              ? `进程已退出（code=${code ?? 'null'}）`
              : `进程启动后立即退出（code=${code ?? 'null'}），请检查 Node 与 npx 是否可用`,
          );
        }
      });
    });
  }

  #onStdout(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > MAX_LINE_BYTES) {
      this.buffer = '';
      this.emit('log', { level: 'error', text: '响应超出缓冲上限，已丢弃' });
      return;
    }

    // MCP stdio framing is newline-delimited JSON. A partial line stays buffered.
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        // A server that prints banners to stdout is not speaking the protocol;
        // surface it rather than failing silently.
        this.emit('log', { level: 'warn', text: line.slice(0, 400) });
        continue;
      }
      this.#onMessage(message);
    }
  }

  #onStderr(chunk) {
    for (const line of String(chunk).split(/\r?\n/)) {
      const text = line.trim();
      if (!text) continue;
      this.stderrTail.push(text);
      if (this.stderrTail.length > 40) this.stderrTail.shift();
      this.emit('log', { level: 'info', text: text.slice(0, 400) });
    }
  }

  #onMessage(message) {
    // A server-initiated request would need its own handler; none is used here.
    if (message.id === undefined) return;

    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);

    if (message.error) {
      entry.reject(new McpError(
        message.error.message ?? 'MCP 请求失败',
        { code: message.error.code ?? null, data: message.error.data ?? null },
      ));
      return;
    }
    entry.resolve(message.result);
  }

  #request(method, params = {}, timeoutMs = 60_000) {
    if (!this.child) {
      return Promise.reject(new McpError(
        'MCP 进程未运行', { code: 'not-running' },
      ));
    }
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpError(`MCP 请求超时：${method}`, { code: 'timeout' }));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });

      try {
        this.child.stdin.write(`${JSON.stringify(payload)}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new McpError(`MCP 写入失败：${error.message}`, { code: 'write' }));
      }
    });
  }

  #notify(method, params = {}) {
    if (!this.child) return;
    try {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    } catch {
      // A dead pipe is reported by the exit handler.
    }
  }

  async #handshake() {
    const result = await this.#request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'dsh-plugin-rea', version: '2.1.0' },
    }, BOOTSTRAP_TIMEOUT_MS);

    this.serverInfo = result?.serverInfo ?? null;
    this.#notify('notifications/initialized');
    return result;
  }

  async #listTools() {
    const collected = [];
    let cursor;

    // The spec allows pagination; REA returns everything in one page, but a
    // loop costs nothing and a truncated list would be a silent data loss.
    for (let page = 0; page < 20; page += 1) {
      const result = await this.#request(
        'tools/list',
        cursor ? { cursor } : {},
        BOOTSTRAP_TIMEOUT_MS,
      );
      for (const tool of result?.tools ?? []) collected.push(tool);
      cursor = result?.nextCursor;
      if (!cursor) break;
    }
    return collected;
  }

  /** Call one tool. `args` must already match the tool's schema. */
  async callTool(name, args = {}, { timeoutMs = 600_000 } = {}) {
    if (this.state !== 'ready') {
      throw new McpError(
        this.state === 'error'
          ? `MCP 未就绪：${this.error}`
          : 'MCP 正在启动，请稍后重试',
        { code: 'not-ready' },
      );
    }
    const result = await this.#request('tools/call', { name, arguments: args }, timeoutMs);
    return result;
  }

  #kill() {
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.kill();
    } catch {
      // Already gone.
    }
  }

  /** Stop the server and reject anything in flight. */
  async stop() {
    this.stopping = true;
    this.#kill();
    for (const [, entry] of this.pending) {
      entry.reject(new McpError('MCP 客户端已关闭', { code: 'closed' }));
    }
    this.pending.clear();
    this.#setState('stopped', '已停止');
  }
}

/**
 * Turn an MCP tool schema into a JSON-Schema object the Host's `tools`
 * service accepts.
 *
 * MCP uses `inputSchema`, which is already JSON Schema; the Host takes
 * `parameters`. The copy is shallow-normalised because some servers omit
 * `type: object`, and a Host that validates strictly would reject it.
 */
export function toHostParameters(tool) {
  const schema = tool?.inputSchema;
  if (!schema || typeof schema !== 'object') {
    return { type: 'object', properties: {}, additionalProperties: true };
  }
  return {
    type: 'object',
    ...schema,
    properties: schema.properties ?? {},
  };
}

/**
 * Flatten an MCP tool result into the text the Host renders.
 *
 * REA returns a `content` array of text/image blocks plus `isError`. The panel
 * and the model both need the text; images are reported by name because the
 * Host's tool channel is text.
 */
export function flattenResult(result) {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const parts = [];

  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    } else if (block?.type === 'image') {
      parts.push(`[image ${block.mimeType ?? 'unknown'}${block.name ? ` ${block.name}` : ''}]`);
    } else if (block?.type === 'resource') {
      parts.push(`[resource ${block.resource?.uri ?? 'unknown'}]`);
    }
  }

  if (parts.length === 0 && result?.structuredContent !== undefined) {
    try {
      parts.push(JSON.stringify(result.structuredContent, null, 2));
    } catch {
      parts.push(String(result.structuredContent));
    }
  }

  return {
    text: parts.join('\n\n'),
    isError: result?.isError === true,
  };
}

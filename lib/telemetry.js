/**
 * Runtime telemetry for the REA workbench.
 *
 * What this records and why:
 *
 *   - **Every tool call** the agent makes, REA or otherwise, with name, duration,
 *     outcome, and error message. That answers "where did it break", which no
 *     amount of engine-status display can.
 *   - **MCP health** as observed from outside the client: whether the `rea`
 *     server's tools are registered in this process and how many.
 *   - **A bounded ring buffer**. An agent can issue hundreds of calls in one
 *     turn; keeping all of them would grow without limit. The buffer keeps the
 *     most recent N and counts what it dropped, so the panel never claims to
 *     show "everything".
 *
 * Design constraints:
 *
 *  - Recording must never break a tool call. Every hook is wrapped so a throw in
 *    telemetry is swallowed and the real tool result survives.
 *  - Errors are aggregated by a normalized key (tool + error shape), so 40
 *    identical failures read as one row with a count instead of 40 lines.
 *  - Nothing here is persisted. This is live operational state, cleared when the
 *    Host restarts, which is the honest scope of "what is happening now".
 */

import { EventEmitter } from 'node:events';
import { explainError, toolLabel } from './error-explain.js';

/** Rows kept for the message stream. Older rows are dropped and counted. */
const MAX_ENTRIES = 500;

/** Distinct error groups tracked at once. */
const MAX_ERROR_GROUPS = 100;

/** Per-tool rolling statistics. */
const MAX_TOOL_STATS = 200;

/**
 * Normalize an error message into a grouping key.
 *
 * Variable data is stripped so two failures of the same kind group together:
 * a port number, a path, a byte offset, a GUID, an address. Without this every
 * occurrence of one bug looks like a different bug.
 */
export function normalizeErrorKey(message) {
  let text = String(message ?? '');

  // Addresses and identifiers first: they would otherwise look like numbers to
  // the later rules.
  text = text.replace(/0x[0-9a-f]+/gi, '0x#');
  text = text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>');

  /**
   * Windows paths may contain spaces (`C:\Program Files\...`), so a single
   * whitespace-delimited token stops at `Program`. The rule is: a drive letter,
   * then everything up to a quoted boundary, a line break, or a trailing
   * all-caps error code — that code is the diagnostic and must survive.
   */
  text = text.replace(/[A-Za-z]:\\[^\r\n"'`|]*?(?=\s+[A-Z][A-Z0-9_]{2,}\b|["'`\r\n|]|$)/g, '<path>');
  // A path with no trailing error word, ending at whitespace.
  text = text.replace(/[A-Za-z]:\\[^\s"'`|]*/g, '<path>');

  // POSIX paths need at least one separator, so a lone `/` is left alone.
  text = text.replace(/\/(?:[^\s'"`]+\/?)+/g, '<path>');

  // Remaining long numbers are offsets, ports and ids, never diagnostic.
  text = text.replace(/\b\d{4,}\b/g, '#');

  // A tool error is often a JSON payload; 200 characters cut it mid-word and
  // hid the actual cause. The panel wraps and clamps instead.
  return text.slice(0, 600);
}

/** Shorten a value for display without destroying its meaning. */
function truncate(text, max = 400) {
  const value = String(text ?? '');
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/**
 * Extract a readable error from whatever a failed tool returned.
 *
 * Tool failures arrive as a materialized result with content blocks, so the text
 * is buried in there rather than being an Error instance.
 */
function extractFailure(result) {
  if (!result || typeof result !== 'object') return null;

  const isError = result.isError === true;
  if (!isError) return null;

  // Prefer the structured failure reason over a rendered block.
  const reason = result.error?.message ?? result.error?.info?.reason;
  if (typeof reason === 'string' && reason.length > 0) {
    return { message: reason, code: result.error?.info?.code ?? null };
  }

  const blocks = Array.isArray(result.content) ? result.content : [];
  const text = blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();

  if (text.length > 0) return { message: truncate(text, 2000), code: null };
  return { message: '工具返回错误，但没有错误文本', code: null };
}

export class ReaTelemetry extends EventEmitter {
  constructor({ maxEntries = MAX_ENTRIES } = {}) {
    super();
    // Many panels may subscribe; the default of 10 would warn past that.
    this.setMaxListeners(50);

    this.maxEntries = maxEntries;
    /** Newest first. */
    this.entries = [];
    /** How many rows fell off the end of the buffer. */
    this.dropped = 0;
    /** Monotonic id so a client can tell new rows from old. */
    this.nextSeq = 1;

    /** Aggregated error groups keyed by `tool::normalizedMessage`. */
    this.errorGroups = new Map();
    /** Per-tool counters. */
    this.toolStats = new Map();

    this.startedAt = Date.now();
    this.counts = {
      total: 0,
      failed: 0,
      rea: 0,
      reaFailed: 0,
      other: 0,
      otherFailed: 0,
    };
    /**
     * Response time is tracked per group, because the two have nothing in
     * common: a REA analysis runs for seconds and a `read` for milliseconds.
     * Averaging them produced a meaningless "680 ms".
     */
    this.ms = {
      rea: { total: 0, calls: 0 },
      other: { total: 0, calls: 0 },
    };
    this.totalMs = 0;
    this.timedCalls = 0;
  }

  /** True when a tool name belongs to the REA server. */
  static isReaTool(name) {
    return typeof name === 'string' && name.startsWith('mcp__rea__');
  }

  /**
   * Record one completed tool call.
   *
   * `failure` is the extracted failure or null; `durationMs` may be null when
   * the start timestamp was unavailable, which is reported rather than guessed.
   */
  record({ name, durationMs, failure, meta }) {
    const seq = this.nextSeq;
    this.nextSeq += 1;

    const isRea = ReaTelemetry.isReaTool(name);
    const failed = failure !== null;

    this.counts.total += 1;
    if (failed) this.counts.failed += 1;

    if (isRea) {
      this.counts.rea += 1;
      if (failed) this.counts.reaFailed += 1;
    } else {
      this.counts.other += 1;
      if (failed) this.counts.otherFailed += 1;
    }

    /**
     * Per-group timing sums. Kept as running accumulators rather than derived
     * from the ring buffer: the buffer drops old entries and its average would
     * drift away from the true figure.
     */
    const bucket = isRea ? this.ms.rea : this.ms.other;
    if (typeof durationMs === 'number' && Number.isFinite(durationMs)) {
      bucket.total += durationMs;
      bucket.calls += 1;
      this.totalMs += durationMs;
      this.timedCalls += 1;
    }

    const entry = {
      seq,
      at: Date.now(),
      tool: name,
      rea: isRea,
      durationMs: typeof durationMs === 'number' && Number.isFinite(durationMs) ? Math.round(durationMs) : null,
      ok: !failed,
      error: failure ? truncate(failure.message, 600) : null,
      errorCode: failure?.code ?? null,
      meta: meta ?? null,
    };

    this.entries.unshift(entry);
    if (this.entries.length > this.maxEntries) {
      const removed = this.entries.length - this.maxEntries;
      this.entries.length = this.maxEntries;
      this.dropped += removed;
    }

    this.#updateToolStats(name, entry);
    if (failed) this.#updateErrorGroups(name, failure);

    // Live subscribers get the row immediately; the buffer is the replay source
    // for a panel that opens later.
    this.emit('entry', entry);
    return entry;
  }

  #updateToolStats(name, entry) {
    const current = this.toolStats.get(name) ?? {
      tool: name,
      rea: entry.rea,
      calls: 0,
      failures: 0,
      totalMs: 0,
      maxMs: 0,
      lastAt: 0,
      lastError: null,
    };

    current.calls += 1;
    if (!entry.ok) {
      current.failures += 1;
      current.lastError = entry.error;
    }
    if (entry.durationMs !== null) {
      current.totalMs += entry.durationMs;
      current.maxMs = Math.max(current.maxMs, entry.durationMs);
    }
    current.lastAt = entry.at;
    this.toolStats.set(name, current);

    // Bound the map: an unusual process could see thousands of dynamic names.
    if (this.toolStats.size > MAX_TOOL_STATS) {
      const oldest = [...this.toolStats.values()].sort((a, b) => a.lastAt - b.lastAt)[0];
      if (oldest) this.toolStats.delete(oldest.tool);
    }
  }

  #updateErrorGroups(name, failure) {
    const key = `${name}::${normalizeErrorKey(failure.message)}`;

    /**
     * The panel rendered the raw English message, which is the one thing a
     * non-programmer cannot act on. The explanation is attached here rather
     * than only in the client so the same Chinese reading is available to every
     * consumer of `/metrics`, including an agent reading the API.
     *
     * `null` when no rule matches: an unknown error keeps its original text
     * rather than being forced into a wrong category.
     */
    const current = this.errorGroups.get(key) ?? {
      key,
      tool: name,
      toolLabel: toolLabel(name),
      message: truncate(failure.message, 300),
      explanation: explainError(failure.message),
      count: 0,
      firstAt: Date.now(),
      lastAt: 0,
    };
    current.count += 1;
    current.lastAt = Date.now();
    this.errorGroups.set(key, current);

    if (this.errorGroups.size > MAX_ERROR_GROUPS) {
      const oldest = [...this.errorGroups.values()].sort((a, b) => a.lastAt - b.lastAt)[0];
      if (oldest) this.errorGroups.delete(oldest.key);
    }
  }

  /** Rows after `sinceSeq`, newest first, for an incremental panel sync. */
  since(sinceSeq = 0) {
    return this.entries.filter((entry) => entry.seq > sinceSeq);
  }

  /**
   * Aggregate view for the panel's summary cards.
   *
   * Slowest and most-failing tools are ranked so a performance or reliability
   * problem is visible without reading the stream.
   */
  snapshot({ entryLimit = 200 } = {}) {
    const tools = [...this.toolStats.values()].map((stat) => ({
      ...stat,
      avgMs: stat.calls > 0 ? Math.round(stat.totalMs / stat.calls) : null,
      failureRate: stat.calls > 0 ? stat.failures / stat.calls : 0,
    }));

    return {
      startedAt: this.startedAt,
      uptimeMs: Date.now() - this.startedAt,
      counts: {
        ...this.counts,
        // Two rates and two averages, never one blended figure: a REA call and
        // an \`edit\` have different success shapes and durations, and combining
        // them produced a number that described neither.
        reaRate: this.counts.rea > 0
          ? (this.counts.rea - this.counts.reaFailed) / this.counts.rea
          : null,
        otherRate: this.counts.other > 0
          ? (this.counts.other - this.counts.otherFailed) / this.counts.other
          : null,
        reaAvgMs: this.ms.rea.calls > 0
          ? Math.round(this.ms.rea.total / this.ms.rea.calls)
          : null,
        otherAvgMs: this.ms.other.calls > 0
          ? Math.round(this.ms.other.total / this.ms.other.calls)
          : null,
        avgMs: this.timedCalls > 0 ? Math.round(this.totalMs / this.timedCalls) : null,
      },
      buffered: this.entries.length,
      dropped: this.dropped,
      maxEntries: this.maxEntries,
      entries: this.entries.slice(0, entryLimit),
      errors: [...this.errorGroups.values()].sort((a, b) => b.lastAt - a.lastAt),
      slowest: [...tools]
        .filter((tool) => tool.avgMs !== null && tool.calls >= 1)
        .sort((a, b) => b.avgMs - a.avgMs)
        .slice(0, 8),
      failing: [...tools]
        .filter((tool) => tool.failures > 0)
        .sort((a, b) => b.failures - a.failures)
        .slice(0, 8),
      reaTools: tools.filter((tool) => tool.rea).length,
    };
  }

  /** Clear counters. The stream keeps its rows unless `clearEntries` is set. */
  reset({ clearEntries = true } = {}) {
    if (clearEntries) {
      this.entries = [];
      this.dropped = 0;
    }
    this.errorGroups.clear();
    this.toolStats.clear();
    this.counts = { total: 0, failed: 0, rea: 0, reaFailed: 0 };
    this.totalMs = 0;
    this.timedCalls = 0;
    this.startedAt = Date.now();
  }
}

/**
 * Attach telemetry to the Host event bus.
 *
 * `tools/execute` is a waterfall that wraps every dispatch, so it supplies the
 * start time; `tools/result` is the frozen final outcome, so it supplies the
 * verdict. Pairing them by call id is what yields a duration.
 *
 * Every callback is guarded: a telemetry bug must never turn a working tool call
 * into a failure.
 */
export function attachTelemetry(ctx, telemetry) {
  const started = new Map();

  const disposeStart = ctx.on('tools/execute', (exec, next) => {
    try {
      const id = String(exec?.callId ?? '');
      if (id) started.set(id, Date.now());
    } catch {
      // Never let bookkeeping break the dispatch.
    }
    return next();
  });

  const disposeResult = ctx.on('tools/result', (exec, result) => {
    try {
      const id = String(exec?.callId ?? '');
      const beganAt = id ? started.get(id) : undefined;
      if (id) started.delete(id);

      telemetry.record({
        name: String(exec?.name ?? 'unknown'),
        durationMs: beganAt ? Date.now() - beganAt : null,
        failure: extractFailure(result),
      });
    } catch {
      // As above: telemetry is observational only.
    }
  });

  // Restrict the start map so an unpaired dispatch cannot leak forever.
  const sweep = setInterval(() => {
    if (started.size > 2000) {
      const keep = [...started.entries()].slice(-1000);
      started.clear();
      for (const [key, value] of keep) started.set(key, value);
    }
  }, 60_000);
  if (typeof sweep.unref === 'function') sweep.unref();

  return () => {
    clearInterval(sweep);
    disposeStart();
    disposeResult();
  };
}

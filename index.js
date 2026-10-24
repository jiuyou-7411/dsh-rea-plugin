/**
 * REA bundle Host half.
 *
 * Responsibility split inside this bundle:
 *
 *   this file        → engine bootstrap, the in-process MCP bridge (207 tools),
 *                      readiness tools, the unpack pipeline, and the HTTP API
 *                      that backs the workbench panel
 *   client.js        → the workbench panel itself
 *
 * The MCP connection is owned here rather than declared as a `rea-mcp` row.
 * A profile row needs `@deepseek-ai/dsh-mcp-client` installed, and that package
 * brings nine exact-version peers; a profile missing any of them starts the row,
 * fails, and reports nothing (the row sets `failOnStartupError: false`). The
 * panel then showed "0 tools" with no way to fix it. Speaking the protocol
 * in-process removes that whole class of failure: the only requirement is Node
 * and npx, which this plugin already needs for its own engines.
 */

import { buildTools } from './lib/tools.js';
import { createApiRoutes } from './lib/api.js';
import { ReaTelemetry, attachTelemetry } from './lib/telemetry.js';
import { CACHE_ROOT, REA_AGENTS_VERSION, providerEnvironment, readConfiguredProviderEnv } from './lib/providers.js';
import { createMcpClient, attachMcpBridge } from './lib/mcp-bridge.js';
import { buildMobileTools } from './lib/tools-mobile.js';
import { buildCliTool, setCliVersion } from './lib/tool-cli.js';
import { buildDocsTool } from './lib/tool-docs.js';
import { installSkills } from './lib/skills-install.js';
import { provision, summarize } from './lib/provision.js';

export const name = 'rea-host';

/**
 * `tools` is required: the five tools are this plugin's agent surface.
 * `webServer` stays optional so a composition without the Web GUI still loads
 * the tools; the panel's routes are simply not registered there.
 */
export const inject = ['tools'];

export function apply(ctx, config = {}) {
  // -------------------------------------------------------------------------
  // Publish skills where DSH discovers them
  //
  // A plugin's own skills/ directory is inert: DSH reads
  // <projectRoot>/.dsh/skills, never a package's internal folder. Without this
  // step the four bundled skills exist in the tarball and never appear in any
  // agent's catalogue.
  //
  // Runs before tool registration so the entries are in place for the first
  // catalogue read. A read-only filesystem degrades to a warning rather than
  // blocking activation.
  // -------------------------------------------------------------------------
  void installSkills()
    .then((report) => {
      if (!report.ok) {
        ctx.logger?.warn?.(`[rea] skills not installed: ${report.reason}`);
        return;
      }
      const total = report.written.length + report.skipped.length;
      const parts = [`[rea] skills at ${report.dir}: ${total} 个`];
      if (report.written.length > 0) parts.push(`写入 ${report.written.length}`);
      if (report.skipped.length > 0) parts.push(`跳过 ${report.skipped.length}`);
      ctx.logger?.info?.(parts.join(', '));
    })
    .catch((error) => {
      ctx.logger?.warn?.(`[rea] skills install failed: ${error?.message ?? error}`);
    });

  const resolved = {
    reaVersion: config?.reaVersion ?? REA_AGENTS_VERSION,
    autoInstallProviders: config?.autoInstallProviders !== false,
    maxProviderDownloadMb: Number(config?.maxProviderDownloadMb ?? 2048),
    providerEnv: config?.providerEnv ?? {},
    // How much of each tool definition reaches the system prompt. Defaults keep
    // the 207 definitions at roughly 43k tokens instead of 215k.
    toolShape: {
      compact: config?.compactToolSchemas !== false,
      maxDepth: Number(config?.toolSchemaDepth ?? 3),
      maxDescriptionChars: Number(config?.toolDescriptionChars ?? 160),
    },
  };

  /**
   * Publish verified engine paths into the process environment.
   *
   * Order of precedence, highest first:
   *   1. an operator-exported variable (never overwritten);
   *   2. the `providerEnv` value from the plugin config;
   *   3. a path this bundle installed and verified.
   *
   * This runs at activation because the `rea-mcp` row launches a child process
   * that inherits this environment. Activation precedes MCP client start, so
   * the engine paths are in place when REA asks for them — the difference
   * between a freshly installed engine reading as ready and reading as missing
   * until a manual edit plus restart.
   */
  const published = [];
  const configured = readConfiguredProviderEnv(resolved.providerEnv);
  const discovered = providerEnvironment();

  for (const [key, value] of Object.entries({ ...discovered, ...configured })) {
    if (process.env[key]) {
      published.push(`${key} (operator-exported, kept)`);
      continue;
    }
    process.env[key] = value;
    published.push(`${key} (${value === configured[key] ? 'config' : 'discovered'})`);
  }

  /**
   * Every tool name this plugin registers, so /status can report an honest
   * total. Before this, the count covered only the MCP half (207) and made the
   * six MobileRE tools and five local helpers look missing.
   */
  const registeredToolNames = [];

  // -------------------------------------------------------------------------
  // Agent tools
  // -------------------------------------------------------------------------
  const tools = buildTools(resolved);

  for (const tool of tools) {
    registeredToolNames.push(tool.name);
    ctx.effect(() => ctx.tools.register({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      output: tool.output,
      execute: tool.execute,
      ...(tool.timeoutMs !== undefined ? { timeoutMs: tool.timeoutMs } : {}),
      ...(tool.isConcurrencySafe !== undefined ? { isConcurrencySafe: tool.isConcurrencySafe } : {}),
    }));
  }

  // -------------------------------------------------------------------------
  // MobileRE tools — the mobile layer REA does not cover
  //
  // Vendored under vendor/mobilere (MIT), invoked as Python subprocesses. They
  // are registered alongside the five REA helpers because from the model's
  // point of view they are the same thing: a local tool.
  // -------------------------------------------------------------------------
  const mobileTools = buildMobileTools({
    pythonPath: resolved.pythonPath,
    mobileToolTimeoutMs: resolved.mobileToolTimeoutMs,
  });

  for (const tool of mobileTools) {
    registeredToolNames.push(tool.name);
    ctx.effect(() => ctx.tools.register({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      output: {
        schema: { type: 'string' },
        render: (value) => (typeof value === 'string' ? value : JSON.stringify(value, null, 2)),
      },
      execute: tool.execute,
      // Two MobileRE runs on the same device would fight over adb/frida.
      isConcurrencySafe: false,
    }));
  }

  // -------------------------------------------------------------------------
  // CLI and documentation tools
  //
  // Two additions that address cost rather than capability:
  //
  //   rea_cli   — the same engine through a command surface with --format json
  //               and --filter-output, so one question costs one small response
  //               instead of a full Evidence envelope.
  //   rea_docs  — a 30 KB index over 72 documents (1.2 MB of prose), so a model
  //               can find and read the one page that explains how to combine
  //               the 207 MCP tools.
  //
  // -------------------------------------------------------------------------
  setCliVersion(resolved.reaVersion);

  const extraTools = [
    buildCliTool({ cliTimeoutMs: resolved.cliTimeoutMs }),
    buildDocsTool(),
  ];

  for (const tool of extraTools) {
    registeredToolNames.push(tool.name);
    ctx.effect(() => ctx.tools.register({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      output: {
        schema: { type: 'string' },
        render: (value) => (typeof value === "string" ? value : JSON.stringify(value, null, 2)),
      },
      execute: tool.execute,
      // The CLI spawns npx; two concurrent runs would fight over the npm cache.
      isConcurrencySafe: false,
    }));
  }

  // -------------------------------------------------------------------------
  // First-run provisioning
  //
  // Runs detached so `apply()` returns and the GUI comes up. The MCP bridge
  // starts on its own below; this fills in the parts that need downloading.
  //
  // Only small engines are fetched automatically. Ghidra is 543 MB and only
  // some users need native analysis, so it stays a one-click decision.
  // -------------------------------------------------------------------------
  let provisionReport = null;

  resolved.provisionStatus = () => (provisionReport
    ? { ...provisionReport, summary: summarize(provisionReport) }
    : { running: true, steps: [], skipped: [] });

  if (resolved.autoInstallProviders) {
    void provision({
      onStep: (step) => {
        ctx.logger?.info?.(`[rea] provision ${step.item}: ${step.status} ${step.detail ?? ''}`.trim());
      },
    })
      .then((report) => {
        provisionReport = report;
        ctx.logger?.info?.(`[rea] provision done: ${summarize(report)}`);
        // The panel re-reads /status on its own cadence, so nothing to poke here.
      })
      .catch((error) => {
        provisionReport = {
          startedAt: Date.now(),
          finishedAt: Date.now(),
          steps: [{ item: "provision", status: "error", detail: error?.message ?? String(error) }],
          skipped: [],
        };
        ctx.logger?.warn?.(`[rea] provision failed: ${error?.message ?? error}`);
      });
  }

  // -------------------------------------------------------------------------
  // MCP bridge — the 207 upstream tools
  //
  // Started here, not through a profile row, so the bundle is self-contained:
  // installing this plugin is all it takes to get the REA tool surface. The
  // start is deliberately non-blocking — `apply` must return so the Web GUI can
  // come up — and a failure is recorded in `mcp.status` for the panel to show
  // and retry, rather than swallowed.
  // -------------------------------------------------------------------------
  const mcpClient = createMcpClient({
    reaVersion: resolved.reaVersion,
    providerEnv: providerEnvironment(),
  });

  let mcpStatus = {
    state: 'idle',
    detail: null,
    toolCount: 0,
    error: null,
    serverInfo: null,
    startedAt: null,
  };

  const mcpBridge = attachMcpBridge(ctx, mcpClient, {
    shape: resolved.toolShape,
    onState(next) {
      mcpStatus = {
        ...mcpStatus,
        ...next,
        startedAt: mcpStatus.startedAt ?? Date.now(),
      };
    },
  });

  /** Start (or restart) the MCP server. Safe to call repeatedly. */
  const startMcp = async () => {
    if (mcpBridge.state === 'ready') return { ok: true, toolCount: mcpBridge.toolCount };
    try {
      const count = await mcpBridge.start();
      return { ok: true, toolCount: count };
    } catch (error) {
      return { ok: false, error: error?.message ?? String(error) };
    }
  };
  resolved.startMcp = startMcp;
  resolved.mcpStatus = () => ({
    ...mcpStatus,
    toolCount: mcpBridge.toolCount,
    state: mcpBridge.state,
    error: mcpBridge.error,
    serverInfo: mcpBridge.serverInfo,
  });

  ctx.effect(() => () => { void mcpBridge.stop(); });

  // Fire and forget: the panel renders "starting" and re-reads when ready.
  void startMcp().then((result) => {
    if (result.ok) {
      // Mirror the MCP names into the shared list. Done here rather than inside
      // the bridge so the bridge stays unaware of /status bookkeeping.
      const mcpNames = typeof mcpBridge.listNames === 'function' ? mcpBridge.listNames() : [];
      for (const name of mcpNames) {
        if (!registeredToolNames.includes(name)) registeredToolNames.push(name);
      }
      ctx.logger?.info?.(`[rea] MCP bridge ready: ${result.toolCount} tools`);
    } else {
      ctx.logger?.warn?.(`[rea] MCP bridge failed: ${result.error}`);
    }
  });

  // -------------------------------------------------------------------------
  // Runtime telemetry
  //
  // Records every tool call and its outcome. This is what lets the panel answer
  // "where did it break" and "what is slow", which engine readiness alone cannot.
  //
  // Isolated on purpose: this runs inside `ctx.effect`, so an exception here
  // aborts the rest of `apply()` — and that silently took the whole HTTP API
  // with it, leaving the panel unable to fetch anything. Telemetry is
  // observational, so it must never be able to stop the workbench from loading.
  // -------------------------------------------------------------------------
  const telemetry = new ReaTelemetry({ maxEntries: Number(resolved.telemetryEntries ?? 500) });
  try {
    ctx.effect(() => attachTelemetry(ctx, telemetry));
  } catch (error) {
    ctx.logger?.warn?.(`[rea] telemetry unavailable: ${error?.message ?? error}`);
  }

  // -------------------------------------------------------------------------
  // Workbench API
  //
  // Registered through `webServer.register`, the supported browser-carrier
  // route. Deferred because a composition without the Web GUI has no webServer
  // and the Host tools must still work there.
  // -------------------------------------------------------------------------
  resolved.listToolNames = () => [...registeredToolNames];

  const api = createApiRoutes(resolved);

  ctx.inject(['webServer'], (scoped) => {
    scoped.effect(() => {
      try {
        const attached = api.attach(scoped.webServer, { telemetry, tools: scoped.tools });
        /*
         * `attach` no longer throws on a bad route. One duplicate path used to
         * abort the loop and leave the panel with no routes at all, which reads
         * as "plugin broken" with no clue why. It reports what failed instead,
         * and that report belongs in the Host log — a partially attached
         * workbench is still a defect worth seeing.
         */
        if (attached?.failed?.length) {
          const detail = attached.failed
            .map((entry) => `${entry.method} ${entry.path}: ${entry.error}`)
            .join('；');
          scoped.logger?.error?.(
            `[rea] ${attached.failed.length} 条路由注册失败（${attached.registered} 条已就绪）：${detail}`,
          );
        }
      } catch (error) {
        // A route failure must be loud: without these routes the panel can only
        // show "not connected", which is exactly the symptom of this bug.
        scoped.logger?.error?.(`[rea] workbench API failed to attach: ${error?.message ?? error}`);
        throw error;
      }
      return () => api.dispose();
    });
  });

  // Activation record. Names the provider variables because a missing one is
  // the most common reason an engine reads as unavailable.
  ctx.logger?.info?.(
    `[rea] host active: ${tools.length} local tools + MCP bridge, `
    + `upstream rea-agents@${resolved.reaVersion}, engines at ${CACHE_ROOT}`
    + (published.length ? `, provider env: ${published.join(', ')}` : ''),
  );
}

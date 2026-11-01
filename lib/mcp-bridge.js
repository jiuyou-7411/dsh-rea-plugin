/**
 * Bridge an MCP server's tools into the Host's tool registry.
 *
 * The plugin owns this rather than relying on a profile row, because the row
 * depends on a package the profile may not have — and a missing package fails
 * silently, leaving the workbench showing "0 tools" with nothing to click.
 *
 * Names are prefixed `mcp__<server>__` to match the Host's own MCP client, so a
 * tool that arrives through this bridge and one that arrives through a profile
 * row are addressed identically in a conversation.
 */

import { McpClient, toHostParameters, flattenResult, trimDescription } from './mcp-client.js';

/** Tool descriptors that carry no useful schema still need the required keys. */
function describeTool(client, tool, shape) {
  const bare = tool.name.replace(/^mcp[_-]{1,2}/i, '');
  return {
    name: `mcp__${client.serverName}__${bare}`,
    description: shape.compact
      ? trimDescription(tool.description, shape.maxDescriptionChars)
      : (tool.description ?? ''),
    parameters: toHostParameters(tool, {
      maxDepth: shape.maxDepth,
      compact: shape.compact,
    }),
    output: {
      schema: { type: 'string' },
      render: (value) => (typeof value === 'string' ? value : JSON.stringify(value, null, 2)),
    },
  };
}

/**
 * The tools worth paying a schema for.
 *
 * `transport: 'hybrid'` registers only these, and the long tail goes through
 * `rea_cli` instead. Measured, the 207 definitions cost 59,551 tokens; these 17
 * cost 4,003 — a 93% cut that keeps an exact schema on the path every session
 * walks (open a target, analyse it, decompile it, follow references).
 *
 * Why not the whole set: 99 of the 207 tools have no CLI equivalent at all
 * (Hopper GUI operations like `goto_address`, the `compare_*` family, the
 * reconstruction ledgers). Dropping to pure CLI would lose those outright.
 *
 * Why not pure CLI anyway: without a schema the model guesses argument names.
 * Observed in this panel's own logs — `rea open_binary` and
 * `COMMAND_NOT_FOUND: 'open'`, because there is no `open` subcommand. The 17
 * here are the ones a wrong guess costs the most.
 */
export const CORE_TOOLS = new Set([
  'open_binary',
  'analyze_function',
  'procedure_pseudo_code',
  'list_procedures',
  'search_procedures',
  'search_strings',
  'xrefs',
  'inspect_binary_layout',
  'inspect_android_package',
  'inspect_android_class',
  'inspect_android_method',
  'analyze_javascript_application',
  'inspect_artifact',
  'extract_firmware',
  'inspect_managed_artifact',
  'inspect_wasm_artifact',
  'inspect_pe_resources',
]);

/**
 * Register every tool the server exposes, and keep the registry in step with
 * reconnects. Returns a controller the plugin uses for status and teardown.
 *
 * `shape` controls how much of each tool definition reaches the model:
 * `compact`, `maxDepth`, `maxDescriptionChars`, and `transport`.
 *
 * `transport` decides which tools are registered at all:
 *   'mcp'    — all 207 (about 60k tokens)
 *   'hybrid' — CORE_TOOLS only (about 4k tokens), rest via `rea_cli`
 *   'cli'    — none; every REA call goes through `rea_cli`
 *
 * The token figures are measured, not estimated; see `compactSchema` in
 * mcp-client.js for the method.
 */
export function attachMcpBridge(ctx, client, { onState, shape } = {}) {
  /** toolName → disposer from ctx.tools.register */
  const registered = new Map();

  const shapeOpts = {
    compact: shape?.compact ?? true,
    // Clamped to at least 1: at depth 0 every parameter collapses to
    // `{type:'object'}`, which describes nothing and would make the tools
    // uncallable. A config typo should not do that.
    maxDepth: Math.max(1, Number(shape?.maxDepth ?? 3)),
    maxDescriptionChars: Number(shape?.maxDescriptionChars ?? 160),
    transport: ['cli', 'hybrid', 'mcp'].includes(shape?.transport) ? shape.transport : 'hybrid',
  };

  /** Which tools this transport exposes. */
  function selectTools(tools) {
    if (shapeOpts.transport === 'cli') return [];
    if (shapeOpts.transport === 'hybrid') return tools.filter((tool) => CORE_TOOLS.has(tool.name));
    return tools;
  }

  function clearTools() {
    for (const dispose of registered.values()) {
      try {
        dispose();
      } catch {
        // A failed unregister must not block the remaining ones.
      }
    }
    registered.clear();
  }

  function registerTools(tools) {
    clearTools();

    for (const tool of selectTools(tools)) {
      const descriptor = describeTool(client, tool, shapeOpts);

      const dispose = ctx.tools.register({
        name: descriptor.name,
        description: descriptor.description,
        parameters: descriptor.parameters,
        output: descriptor.output,

        async execute(args) {
          // REA calls can take minutes (Ghidra analysis, firmware extraction).
          // The per-call timeout is generous on purpose; the Host's own
          // timeout is the outer bound.
          const result = await client.callTool(tool.name, args ?? {}, {
            timeoutMs: 600_000,
          });
          const flat = flattenResult(result);
          if (flat.isError) {
            // Throwing is how a tool reports failure to the Host, so the
            // telemetry layer records it as failed rather than successful.
            throw new Error(flat.text || `工具 ${tool.name} 返回错误`);
          }
          return flat.text;
        },

        // REA tools mutate nothing outside their own cache, and two analyses of
        // different artifacts are independent.
        isConcurrencySafe: true,
      });

      registered.set(descriptor.name, dispose);
    }
  }

  /** Upstream total, before this transport narrowed it. Shown in the panel. */
  let upstreamCount = 0;

  client.on('tools', ({ tools }) => {
    upstreamCount = Array.isArray(tools) ? tools.length : 0;
    registerTools(tools);
    onState?.({
      state: client.state,
      toolCount: registered.size,
      upstreamCount,
      transport: shapeOpts.transport,
      error: client.error,
    });
  });

  client.on('state', ({ state, detail }) => {
    onState?.({
      state,
      detail,
      toolCount: registered.size,
      upstreamCount,
      transport: shapeOpts.transport,
      error: client.error,
      serverInfo: client.serverInfo,
    });
  });

  return {
    get toolCount() {
      return registered.size;
    },
    /** Tools the upstream server exposes, regardless of transport. */
    get upstreamCount() {
      return upstreamCount;
    },
    get transport() {
      return shapeOpts.transport;
    },
    get state() {
      return client.state;
    },
    get error() {
      return client.error;
    },
    get serverInfo() {
      return client.serverInfo;
    },
    /** Tool names currently registered by this bridge. */
    listNames() {
      return [...registered.keys()];
    },
    /** Start (or restart) the server and register whatever it exposes. */
    async start() {
      const tools = await client.start();
      // `client.start()` already emitted `tools`, which registered them; this
      // guard covers a restart that resolved before the listener ran.
      if (registered.size === 0 && tools.length > 0) registerTools(tools);
      return registered.size;
    },
    async stop() {
      clearTools();
      await client.stop();
    },
  };
}

/** Build a client from the resolved plugin config. */
export function createMcpClient(config) {
  return new McpClient({
    name: 'rea',
    command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
    args: ['-y', `rea-agents@${config.reaVersion ?? '6.7.0'}`, 'mcp'],
    env: config.providerEnv ?? {},
  });
}

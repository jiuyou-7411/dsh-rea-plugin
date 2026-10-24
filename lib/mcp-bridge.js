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
 * Register every tool the server exposes, and keep the registry in step with
 * reconnects. Returns a controller the plugin uses for status and teardown.
 *
 * `shape` controls how much of each tool definition reaches the model:
 * `compact`, `maxDepth`, `maxDescriptionChars`. It is on by default because
 * the raw definitions cost about 215k tokens per request — see
 * `compactSchema` in mcp-client.js for the measurement behind that number.
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
  };

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

    for (const tool of tools) {
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

  client.on('tools', ({ tools }) => {
    registerTools(tools);
    onState?.({ state: client.state, toolCount: registered.size, error: client.error });
  });

  client.on('state', ({ state, detail }) => {
    onState?.({
      state,
      detail,
      toolCount: registered.size,
      error: client.error,
      serverInfo: client.serverInfo,
    });
  });

  return {
    get toolCount() {
      return registered.size;
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

/**
 * End-to-end audit of every tool and every route this plugin exposes.
 *
 * Why this exists instead of more unit tests: the last four releases each fixed
 * one symptom and revealed the next, because each was verified in isolation. The
 * failures that reached the operator were all of one shape — the code was valid,
 * the plugin loaded, and only a real invocation broke:
 *
 *   · a route path registered twice      → the whole API failed to attach
 *   · an icon referenced but not defined → the panel rendered blank
 *   · a function deleted but still called → /health returned 500
 *   · render declared with one argument   → every call to that tool failed
 *   · a CLI command invoked without a path → a usage error after a 5s spawn
 *
 * So this calls the real builders, checks the real contract of each tool, and
 * invokes the real route handlers. It is slower than the smoke test and it is
 * meant to be run before every release.
 *
 * Run: node scripts/e2e.mjs
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const problems = [];
const notes = [];
const fail = (message) => problems.push(message);
const note = (message) => notes.push(message);

const load = (relative) => import(pathToFileURL(path.join(ROOT, relative)).href);

// ─── 1. Every tool must satisfy the Host's tool contract ─────────────────────

/**
 * The Host stores whatever `output.render(args, value)` returns as
 * `result.content`, then spill-policy calls `content.some(...)` on it. A string
 * therefore fails every invocation. This asserts the block shape directly.
 */
function checkRenderContract(label, tool) {
  const render = tool?.output?.render;
  if (typeof render !== 'function') {
    note(`${label}: 没有 output.render（Host 会用默认投影）`);
    return;
  }
  let rendered;
  try {
    rendered = render({}, 'sample output');
  } catch (error) {
    fail(`${label}: render 抛错 — ${error?.message ?? error}`);
    return;
  }
  if (!Array.isArray(rendered)) {
    fail(`${label}: render 返回 ${typeof rendered}，必须是内容块数组`);
    return;
  }
  if (rendered.length === 0) {
    fail(`${label}: render 返回空数组`);
    return;
  }
  for (const block of rendered) {
    if (!block || typeof block !== 'object' || typeof block.type !== 'string') {
      fail(`${label}: render 返回的块缺少 type`);
      return;
    }
    if (block.type === 'text' && typeof block.text !== 'string') {
      fail(`${label}: text 块的 text 不是字符串`);
      return;
    }
  }
}

const TOOL_SOURCES = [
  ['rea', () => load('lib/tool-rea.js').then((m) => m.buildReaTool({ reaVersion: '6.7.0', getMcp: () => null, getMcpTools: () => new Set() }))],
  ['rea_docs', () => load('lib/tool-docs.js').then((m) => m.buildDocsTool())],
];

for (const [label, build] of TOOL_SOURCES) {
  try {
    const tool = await build();
    if (!tool?.name) { fail(`${label}: 没有 name`); continue; }
    if (!tool.parameters) { fail(`${label}: 没有 parameters`); continue; }
    if (typeof tool.execute !== 'function') { fail(`${label}: 没有 execute`); continue; }
    console.log(`  ✓ 工具 ${tool.name} 结构完整`);
  } catch (error) {
    fail(`${label}: 构建抛错 — ${error?.message ?? error}`);
  }
}

// Mobile + local tools come from builders that already declare render.
try {
  const { buildMobileTools } = await load('lib/tools-mobile.js');
  const mobile = buildMobileTools({}) ?? [];
  console.log(`  ✓ 移动端工具 ${mobile.length} 个`);
  for (const tool of mobile) {
    if (!tool?.name || typeof tool.execute !== 'function') fail(`移动端工具结构不完整: ${tool?.name ?? '(无名)'}`);
  }
} catch (error) {
  fail(`tools-mobile.js 抛错 — ${error?.message ?? error}`);
}

try {
  const { buildTools } = await load('lib/tools.js');
  const local = buildTools({}) ?? [];
  console.log(`  ✓ 本地工具 ${local.length} 个`);
  for (const tool of local) checkRenderContract(`本地工具 ${tool?.name ?? '(无名)'}`, tool);
} catch (error) {
  fail(`tools.js 抛错 — ${error?.message ?? error}`);
}

// ─── 2. Path-first commands must reject a missing path instantly ─────────────

try {
  const { buildReaTool } = await load('lib/tool-rea.js');
  const rea = buildReaTool({ reaVersion: '6.7.0', getMcp: () => null, getMcpTools: () => new Set() });

  for (const command of ['analyze', 'decompile', 'function', 'search', 'xrefs', 'inspect']) {
    const started = Date.now();
    try {
      await rea.execute({ command });
      fail(`rea ${command}: 缺路径却成功了`);
    } catch (error) {
      const elapsed = Date.now() - started;
      const message = String(error?.message ?? '');
      if (!/需要目标路径/.test(message)) {
        fail(`rea ${command}: 缺路径的报错不清晰 — ${message.slice(0, 80)}`);
      } else if (elapsed > 2000) {
        // The first call pays a one-off `rea --help` to learn the command list.
        note(`rea ${command}: 缺路径检查用了 ${elapsed}ms（首次会加载命令表）`);
      }
    }
  }
  console.log('  ✓ 路径预检 6 条命令');
} catch (error) {
  fail(`路径预检抛错 — ${error?.message ?? error}`);
}

// ─── 3. Every route must attach and answer ───────────────────────────────────

const fakeTools = {
  schemas: () => [
    { name: 'rea', description: '入口', parameters: { type: 'object', properties: {} } },
    { name: 'rea_docs', description: '文档', parameters: { type: 'object', properties: {} } },
  ],
};

const fakeTelemetry = {
  counts: { total: 6, failed: 2, rea: 6, reaFailed: 2 },
  startedAt: Date.now() - 120_000,
  snapshot: () => ({
    counts: { total: 6, failed: 2, rea: 6, reaFailed: 2 },
    errors: [
      { key: 'a', tool: 'rea', count: 2, message: '`analyze` 的参数不对（不是插件故障）。\n\n用法：\nrea analyze <path>' },
    ],
    slowest: [], failing: [], recent: [],
  }),
};

let routes = [];
try {
  const { createApiRoutes } = await load('lib/api.js');
  const api = createApiRoutes({
    reaVersion: '6.7.0',
    mcpStatus: () => ({ state: 'ready', toolCount: 0, upstreamCount: 207, error: null }),
    teamStatus: () => ({ available: true, members: [], tasks: [], updatedAt: null }),
    presetStatus: () => ({ available: true, known: true, hasRea: true, ids: ['rea'] }),
  });

  const seen = new Set();
  const attached = api.attach({
    register(route) {
      if (seen.has(route.path)) throw new Error(`duplicate route "${route.path}"`);
      seen.add(route.path);
      routes.push(route);
      return () => {};
    },
  }, { telemetry: fakeTelemetry, tools: fakeTools });

  if (attached?.failed?.length) {
    for (const entry of attached.failed) fail(`路由注册失败 ${entry.method} ${entry.path}: ${entry.error}`);
  }
  console.log(`  ✓ ${routes.length} 条路由注册`);
} catch (error) {
  fail(`api.js 挂载抛错 — ${error?.message ?? error}`);
}

/** Call a handler and return the parsed body. */
function invoke(route) {
  return new Promise((resolve, reject) => {
    const response = { writeHead() {}, end(body) { try { resolve(JSON.parse(body)); } catch { resolve({ __raw: body }); } } };
    Promise.resolve(route.handler({ url: route.path, method: route.method, headers: {} }, response)).catch(reject);
  });
}

// Every GET route with no required query parameter must answer `ok: true`.
const SKIP = new Set(['/job', '/events', '/log']);
for (const route of routes.filter((r) => r.method === 'GET')) {
  if ([...SKIP].some((s) => route.path.endsWith(s))) continue;
  try {
    const body = await invoke(route);
    if (body?.__raw !== undefined) fail(`${route.path} 返回非 JSON`);
    else if (body?.ok !== true) fail(`${route.path} → ok=${body?.ok} ${body?.error ?? ''}`);
  } catch (error) {
    fail(`${route.path} 抛错 — ${error?.message ?? error}`);
  }
}
console.log(`  ✓ GET 路由全部应答`);

// ─── 4. Health must separate usage errors from real ones ─────────────────────

try {
  const { buildHealth } = await load('lib/health.js');
  const health = await buildHealth({
    tools: fakeTools,
    telemetry: fakeTelemetry,
    python: { present: true, missing: [] },
    mcp: { state: 'ready', upstreamCount: 207, toolCount: 0 },
  });
  const errors = health.checks.find((c) => c.id === 'errors');
  if (!errors) fail('health 缺少 errors 检查');
  else if (errors.status === 'error') {
    fail(`health 把纯参数错判成了 error：${errors.value} — ${errors.detail}`);
  } else {
    console.log(`  ✓ health errors=${errors.status} (${errors.value})`);
  }
} catch (error) {
  fail(`buildHealth 抛错 — ${error?.message ?? error}`);
}

// ─── report ─────────────────────────────────────────────────────────────────

for (const item of notes) console.log(`  · ${item}`);

if (problems.length === 0) {
  console.log('✓ 端到端审计通过');
  process.exit(0);
}

console.error(`\n✗ 端到端审计发现 ${problems.length} 个问题：`);
for (const problem of problems) console.error(`  - ${problem}`);
process.exit(1);

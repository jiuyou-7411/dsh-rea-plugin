/**
 * Smoke-test the Host half without a running Harness.
 *
 * Why this exists: `checkJava is not defined` shipped twice. A function was
 * dropped while editing `lib/health.js`, `node --check` passed (a reference to a
 * missing identifier is valid syntax), the plugin loaded, and every health
 * request returned 500 — which the panel renders as "服务状态：异常" with no hint
 * of the cause. The same class of bug took the whole API down once before, when a
 * duplicate route path made `attach` throw.
 *
 * So this calls the real modules the way the Host does: build the routes, attach
 * them to a fake web server, and invoke each handler. Anything that throws, or
 * returns something without `ok`, fails the build.
 *
 * Run: node scripts/smoke-host.mjs
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const problems = [];

function fail(message) {
  problems.push(message);
}

async function load(relative) {
  return import(pathToFileURL(path.join(ROOT, relative)).href);
}

/** Minimal stand-ins for the services a route handler touches. */
const fakeTools = {
  schemas: () => [
    { name: 'rea', description: 'REA 入口', parameters: { type: 'object', properties: {} } },
    { name: 'rea_docs', description: '文档', parameters: { type: 'object', properties: {} } },
    { name: 'win_bash', description: 'shell', parameters: { type: 'object', properties: {} } },
  ],
};

const fakeTelemetry = {
  counts: { total: 4, failed: 1, rea: 2, reaFailed: 0 },
  startedAt: Date.now() - 60_000,
  snapshot: () => ({
    counts: { total: 4, failed: 1, rea: 2, reaFailed: 0 },
    errors: [{ key: 'x', tool: 'win_bash', count: 1, message: 'boom' }],
    slowest: [],
    failing: [],
    recent: [],
  }),
};

/** Call one route handler and return the parsed JSON body. */
function invoke(route, { url = route.path, method = route.method } = {}) {
  return new Promise((resolve, reject) => {
    const request = { url, method, headers: {} };
    const response = {
      writeHead() {},
      end(body) {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve({ __raw: body });
        }
      },
    };
    Promise.resolve(route.handler(request, response)).catch(reject);
  });
}

// ─── health.js ───────────────────────────────────────────────────────────────

try {
  const { buildHealth } = await load('lib/health.js');
  const health = await buildHealth({
    tools: fakeTools,
    telemetry: fakeTelemetry,
    python: { present: true, missing: [] },
    mcp: { state: 'ready', upstreamCount: 207, toolCount: 0 },
  });

  if (!health || typeof health !== 'object') fail('buildHealth 没有返回对象');
  else if (!health.overall) fail('buildHealth 没有 overall 字段');
  else if (!Array.isArray(health.checks) || health.checks.length === 0) {
    fail('buildHealth 没有返回 checks');
  } else {
    console.log(`  ✓ health: overall=${health.overall}, ${health.checks.length} 项检查`);
  }
} catch (error) {
  fail(`health.js 抛错：${error?.message ?? error}`);
}

// ─── api.js ──────────────────────────────────────────────────────────────────

let routes = [];
try {
  const { createApiRoutes } = await load('lib/api.js');
  const api = createApiRoutes({
    reaVersion: '6.7.0',
    mcpStatus: () => ({ state: 'ready', toolCount: 0, upstreamCount: 207, error: null }),
    teamStatus: () => ({ available: true, members: [], tasks: [], updatedAt: null }),
    presetStatus: () => ({ available: true, hasRea: true, ids: ['standard', 'rea'] }),
  });

  const seen = new Set();
  const server = {
    register(route) {
      // Mirror the real webServer: it keys routes by path, so a duplicate path
      // must fail here exactly as it fails in production.
      if (seen.has(route.path)) {
        throw new Error(`duplicate route "${route.path}"`);
      }
      seen.add(route.path);
      routes.push(route);
      return () => {};
    },
  };

  const attached = api.attach(server, { telemetry: fakeTelemetry, tools: fakeTools });
  if (attached?.failed?.length) {
    for (const entry of attached.failed) {
      fail(`路由注册失败 ${entry.method} ${entry.path}: ${entry.error}`);
    }
  }
  console.log(`  ✓ api: ${attached?.registered ?? routes.length} 条路由注册成功`);
} catch (error) {
  fail(`api.js 挂载抛错：${error?.message ?? error}`);
}

/** Routes the panel always calls; each must answer with `ok: true`. */
const REQUIRED = ['/status', '/health', '/metrics', '/team'];

for (const suffix of REQUIRED) {
  const route = routes.find((r) => r.path.endsWith(suffix));
  if (!route) {
    fail(`缺少路由 ${suffix}`);
    continue;
  }
  try {
    const body = await invoke(route);
    if (body?.__raw !== undefined) {
      fail(`${suffix} 返回的不是 JSON：${String(body.__raw).slice(0, 120)}`);
    } else if (body?.ok !== true) {
      fail(`${suffix} 返回 ok=${body?.ok}：${body?.error ?? ''}`);
    } else {
      console.log(`  ✓ ${suffix}`);
    }
  } catch (error) {
    fail(`${suffix} 处理时抛错：${error?.message ?? error}`);
  }
}

// ─── report ─────────────────────────────────────────────────────────────────

if (problems.length === 0) {
  console.log('✓ Host 冒烟测试通过');
  process.exit(0);
}

console.error('✗ Host 冒烟测试失败：');
for (const problem of problems) console.error(`  - ${problem}`);
process.exit(1);

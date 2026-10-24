/**
 * Static checks on `client.js` that a syntax check cannot catch.
 *
 * Why this exists: `Icon.download()` was referenced before it was defined. The
 * file parsed fine, the module loaded fine, and the panel rendered — then threw
 * `TypeError: Icon.download is not a function` inside the slot entry and
 * replaced the entire workbench with a blank page. `node --check` cannot see
 * that, and neither can a render test that only exercises the default tab.
 *
 * So this walks the source and compares every `Icon.<name>` reference against
 * the keys actually declared on the `Icon` object. It is cheap, it runs before
 * publish, and it would have caught both blank-panel incidents in this file's
 * history (this one, and the duplicate-route bug that made every API route
 * fail — the second check below).
 *
 * Run: node scripts/check-client.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const CLIENT = path.join(ROOT, 'client.js');

const source = fs.readFileSync(CLIENT, 'utf8');
const problems = [];

// ─── 1. Icon references must exist ────────────────────────────────────────

const iconStart = source.indexOf('const Icon = {');
if (iconStart === -1) {
  problems.push('找不到 `const Icon = {`，检查脚本需要更新');
} else {
  const iconEnd = source.indexOf('\n    };', iconStart);
  if (iconEnd === -1) {
    problems.push('找不到 Icon 对象的结尾');
  } else {
    const body = source.slice(iconStart, iconEnd);
    const defined = new Set();
    // Keys sit at six spaces of indentation inside the object literal.
    for (const match of body.matchAll(/^\s{6}([a-zA-Z_][a-zA-Z0-9_]*):/gm)) {
      defined.add(match[1]);
    }

    const used = new Set();
    for (const match of source.matchAll(/Icon\.([a-zA-Z_][a-zA-Z0-9_]*)/g)) {
      used.add(match[1]);
    }

    const missing = [...used].filter((name) => !defined.has(name));
    if (missing.length > 0) {
      problems.push(
        `Icon 引用了未定义的图标：${missing.join('、')}`
        + `（已定义 ${defined.size} 个：${[...defined].join(' ')}）`,
      );
    }

    const unused = [...defined].filter((name) => !used.has(name));
    if (unused.length > 0) {
      // A warning, not a failure: an icon kept for an upcoming view is fine.
      console.log(`  · 未使用的图标（不阻塞）：${unused.join('、')}`);
    }
  }
}

// ─── 2. API paths must be unique ──────────────────────────────────────────
//
// The Host's webServer keys routes by path alone, so a GET and a POST on the
// same path makes the second registration throw — and before `attach` grew a
// per-route try/catch, that aborted every remaining route and blanked the panel.

const apiSource = fs.readFileSync(path.join(ROOT, 'lib', 'api.js'), 'utf8');
const routePaths = [];
for (const match of apiSource.matchAll(/path:\s*'(\/api\/[^']+)'/g)) {
  routePaths.push(match[1]);
}
const seen = new Map();
for (const routePath of routePaths) {
  seen.set(routePath, (seen.get(routePath) ?? 0) + 1);
}
const duplicates = [...seen.entries()].filter(([, count]) => count > 1).map(([p]) => p);
if (duplicates.length > 0) {
  problems.push(
    `lib/api.js 里有重复的路由路径：${duplicates.join('、')}`
    + '（webServer 按路径去重，重复会让注册抛错）',
  );
}

// ─── 3. Every API path the client calls must exist on the Host ────────────

const clientApiStart = source.indexOf('const API = {');
if (clientApiStart !== -1) {
  const clientApiEnd = source.indexOf('\n    };', clientApiStart);
  const clientApiBody = source.slice(clientApiStart, clientApiEnd);
  const calledPaths = [...clientApiBody.matchAll(/'(\/api\/[^']+)'/g)].map((m) => m[1]);
  const hostPaths = new Set(routePaths);
  const unknown = calledPaths.filter((p) => !hostPaths.has(p));
  if (unknown.length > 0) {
    problems.push(
      `client.js 调用了 Host 未注册的路径：${unknown.join('、')}`,
    );
  }
}

// ─── Report ───────────────────────────────────────────────────────────────

if (problems.length === 0) {
  console.log('✓ client.js 静态检查通过');
  process.exit(0);
}

console.error('✗ client.js 静态检查失败：');
for (const problem of problems) console.error(`  - ${problem}`);
process.exit(1);

/**
 * Pre-flight check for a distributable tarball.
 *
 * A published package is hard to retract, and the failure mode here is quiet:
 * a missing `vendor/rea-docs/docs` tree turns every `rea_docs` read into "文档
 * 未随插件分发", and a missing `lib/jdk.js` crashes activation with an import
 * error the user cannot diagnose.
 *
 * So this asserts the things an install needs and reports every gap before
 * anyone runs `npm publish`.
 *
 * Run: node scripts/verify-package.mjs
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

/** Files without which activation or a core tool breaks. */
const REQUIRED = [
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'package.json',
  'icon.svg',
  'lib/api.js',
  'lib/mcp-client.js',
  'lib/mcp-bridge.js',
  'lib/providers.js',
  'lib/python-install.js',
  'lib/pip-mirrors.js',
  'lib/tools-mobile.js',
  'lib/tool-cli.js',
  'lib/tool-docs.js',
  'lib/jdk.js',
  'lib/provision.js',
  'lib/skills-install.js',
  'lib/health.js',
  'lib/telemetry.js',
  'lib/tools.js',
  'lib/unpack.js',
  'vendor/rea-docs/index.json',
  'vendor/rea-docs/VENDORED',
  'vendor/rea-docs/docs/cli.md',
  'vendor/rea-skills/manifest.json',
  'vendor/rea-skills/reverse-engineer-anything/SKILL.md',
];

/** Directories whose contents are counted rather than listed. */
const COUNTS = [
  { dir: 'vendor/rea-docs/docs', expect: 72, label: '文档全文' },
  { dir: 'vendor/rea-skills', expect: 12, label: '技能文件', recursive: true },
  { dir: 'vendor/mobilere', expect: 80, label: 'MobileRE', recursive: true },
  { dir: 'skills', expect: 4, label: 'DSH 技能' },
];

/** Paths that must never ship. */
const FORBIDDEN = [
  { pattern: /^runs\//, reason: '工作产物' },
  { pattern: /^_/, reason: '临时脚本' },
  { pattern: /\.mjs$/, reason: '补丁脚本', allowIn: ['scripts/'] },
  { pattern: /node_modules/, reason: '依赖' },
];

async function countFiles(dir, recursive) {
  const absolute = path.join(ROOT, dir);
  if (!existsSync(absolute)) return 0;

  let total = 0;
  for (const entry of await fs.readdir(absolute, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (recursive) total += await countFiles(path.join(dir, entry.name), recursive);
    } else {
      total += 1;
    }
  }
  return total;
}

async function main() {
  const problems = [];
  const notes = [];

  // 1. Required files
  console.log('必需文件：');
  for (const file of REQUIRED) {
    if (existsSync(path.join(ROOT, file))) {
      continue;
    }
    problems.push(`缺少 ${file}`);
    console.log(`  ✗ ${file}`);
  }
  const missingShown = REQUIRED.filter((f) => !existsSync(path.join(ROOT, f)));
  if (missingShown.length === 0) console.log(`  ✓ ${REQUIRED.length} 个全部存在`);

  // 2. Content counts
  console.log('\n内容数量：');
  for (const spec of COUNTS) {
    const actual = await countFiles(spec.dir, spec.recursive);
    const ok = actual === spec.expect;
    console.log(`  ${ok ? '✓' : '✗'} ${spec.label.padEnd(12)} ${actual} / ${spec.expect}`);
    if (!ok) {
      problems.push(`${spec.dir} 应为 ${spec.expect} 个，实际 ${actual}`);
    }
  }

  // 3. Forbidden paths
  console.log('\n禁止路径：');
  let forbiddenCount = 0;
  const walk = async (dir) => {
    for (const entry of await fs.readdir(path.join(ROOT, dir), { withFileTypes: true })) {
      const relative = dir ? `${dir}/${entry.name}` : entry.name;
      if (relative === '.git' || relative.startsWith('.git/')) continue;
      if (relative === 'node_modules' || relative.startsWith('node_modules/')) continue;

      if (entry.isDirectory()) {
        const rule = FORBIDDEN.find((r) => r.pattern.test(`${relative}/`) && !r.allowIn);
        if (rule) {
          problems.push(`${relative}/ 不应打包（${rule.reason}）`);
          console.log(`  ✗ ${relative}/ (${rule.reason})`);
          forbiddenCount += 1;
          continue;
        }
        await walk(relative);
        continue;
      }

      const rule = FORBIDDEN.find(
        (r) => r.pattern.test(relative) && !(r.allowIn ?? []).some((dir2) => relative.startsWith(dir2)),
      );
      if (rule) {
        problems.push(`${relative} 不应打包（${rule.reason}）`);
        console.log(`  ✗ ${relative} (${rule.reason})`);
        forbiddenCount += 1;
      }
    }
  };
  await walk('');
  if (forbiddenCount === 0) console.log('  ✓ 无残留文件');

  // 4. Manifest sanity
  console.log('\n清单：');
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  if (pkg.private) problems.push('package.json 仍标记 private，无法发布');
  if (!pkg.files?.includes('vendor/**')) problems.push('files 未包含 vendor/**');
  if (!pkg.dsh?.bundle?.patch) problems.push('dsh.bundle.patch 缺失，DSH 不会加载插件');
  console.log(`  name     ${pkg.name}`);
  console.log(`  version  ${pkg.version}`);
  console.log(`  private  ${pkg.private}`);
  console.log(`  files    ${pkg.files?.length ?? 0} 条规则`);

  // 5. Absolute paths leaking into shipped code
  console.log('\n硬编码路径：');
  const leaks = [];
  const scan = async (dir) => {
    for (const entry of await fs.readdir(path.join(ROOT, dir), { withFileTypes: true })) {
      const relative = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (['node_modules', 'vendor', '.git'].includes(entry.name)) continue;
        await scan(relative);
        continue;
      }
      if (!/\.(js|mjs|yml|json)$/.test(entry.name)) continue;
      const text = await fs.readFile(path.join(ROOT, relative), 'utf8');
      // A developer home directory in shipped code is a packaging bug: it
      // means the plugin was written against one machine.
      const hit = /["']([A-Za-z]:[\\/][^"']{8,})["']/.exec(text);
      if (hit && /Users[\\/]|Documents|Desktop/.test(hit[1])) {
        leaks.push(`${relative}: ${hit[1]}`);
      }
    }
  };
  await scan('');
  if (leaks.length === 0) console.log('  ✓ 无本地绝对路径');
  else leaks.forEach((line) => { console.log(`  ✗ ${line}`); problems.push(line); });

  // Summary
  console.log('');
  if (problems.length === 0) {
    const size = await dirSize(ROOT);
    console.log(`✓ 可以打包（源码 ${(size / 1024 / 1024).toFixed(1)} MB）`);
    console.log('  下一步： npm pack');
    return;
  }

  console.log(`✗ ${problems.length} 个问题：`);
  problems.forEach((line) => console.log(`  - ${line}`));
  process.exit(1);
}

async function dirSize(dir) {
  let total = 0;
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (['node_modules', '.git'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(full);
    else total += (await fs.stat(full)).size;
  }
  return total;
}

main().catch((error) => {
  console.error('检查失败：', error.message);
  process.exit(1);
});

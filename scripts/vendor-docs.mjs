/**
 * Vendor the upstream `docs/` Markdown into the package.
 *
 * The index alone is not enough for a distributed plugin. `tool-docs.js` falls
 * back to `raw.githubusercontent.com` when a body is missing, which means:
 *
 *  - a user behind a firewall gets "文档拉取失败" instead of documentation;
 *  - a user offline gets nothing;
 *  - the content can drift from the indexed commit if the fallback URL is ever
 *    unpinned.
 *
 * So the bodies ship. 1.2 MB of Markdown is a reasonable price for a plugin that
 * then needs no network to explain itself.
 *
 * Run: node scripts/vendor-docs.mjs
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const INDEX = path.join(ROOT, 'vendor', 'rea-docs', 'index.json');
const OUT = path.join(ROOT, 'vendor', 'rea-docs', 'docs');

const CONCURRENCY = 6;

async function fetchWithRetry(url, attempt = 1) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } catch (error) {
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, 300 * attempt));
      return fetchWithRetry(url, attempt + 1);
    }
    throw error;
  }
}

async function main() {
  const index = JSON.parse(await fs.readFile(INDEX, 'utf8'));
  const { repo, ref, docs } = index;

  console.log(`仓库 ${repo} @ ${ref.slice(0, 12)}`);
  console.log(`文档 ${docs.length} 篇\n`);

  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(OUT, { recursive: true });

  let written = 0;
  let bytes = 0;
  const failed = [];

  // Small worker pool: sequential is slow over 72 files, and unbounded
  // parallelism trips the CDN's rate limiting.
  let cursor = 0;

  async function worker() {
    for (;;) {
      const position = cursor;
      cursor += 1;
      if (position >= docs.length) return;

      const doc = docs[position];
      const url = `https://raw.githubusercontent.com/${repo}/${ref}/docs/${doc.slug}`;

      try {
        const text = await fetchWithRetry(url);
        await fs.writeFile(path.join(OUT, doc.slug), text, 'utf8');
        written += 1;
        bytes += Buffer.byteLength(text);
        process.stdout.write('.');
      } catch (error) {
        failed.push(`${doc.slug} (${error.message})`);
        process.stdout.write('x');
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log(`\n\n写入 ${written} / ${docs.length} 篇，${(bytes / 1024 / 1024).toFixed(2)} MB`);

  if (failed.length > 0) {
    console.log(`\n失败 ${failed.length} 篇：`);
    failed.forEach((line) => console.log(`  ${line}`));
    console.log('\n重跑一次通常可补齐。');
    process.exit(1);
  }

  // Record the vendoring so a packaged install can assert it needs no network.
  await fs.writeFile(
    path.join(ROOT, 'vendor', 'rea-docs', 'VENDORED'),
    `repo: ${repo}\nref: ${ref}\ndocs: ${written}\nbytes: ${bytes}\n`,
    'utf8',
  );
  console.log('\n已标记 VENDORED：安装后读取文档不需要联网。');
}

main().catch((error) => {
  console.error('失败：', error.message);
  process.exit(1);
});

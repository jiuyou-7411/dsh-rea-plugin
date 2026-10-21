/**
 * Generate vendor/rea-docs/index.json from the upstream docs directory.
 *
 * Run: node scripts/gen-doc-index.mjs [ref]
 *
 * Why generate instead of hand-write: the index must stay in step with the
 * upstream docs, and a hand-maintained list of 72 entries goes stale silently.
 * Why a pinned ref: `raw.githubusercontent.com` is content-addressed by commit,
 * so a doc fetched later cannot change under an install that was verified
 * against a different one.
 *
 * The summary is the document's first non-heading paragraph, truncated. That is
 * enough for a model to decide whether to open it, which is the whole job of the
 * index — the body is fetched on demand.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, '..', 'vendor', 'rea-docs');
const OUT_FILE = path.join(OUT_DIR, 'index.json');

const REPO = 'morluto/rea';

/** Resolve a branch to a commit so the index is pinned to immutable content. */
async function resolveRef(branch) {
  const response = await fetch(`https://api.github.com/repos/${REPO}/commits/${branch}`, {
    headers: { accept: 'application/vnd.github+json' },
  });
  if (!response.ok) throw new Error(`无法解析 ${branch}：HTTP ${response.status}`);
  const json = await response.json();
  return json.sha;
}

/** List the .md files in docs/ at that commit. */
async function listDocs(ref) {
  const response = await fetch(
    `https://api.github.com/repos/${REPO}/contents/docs?ref=${ref}`,
    { headers: { accept: 'application/vnd.github+json' } },
  );
  if (!response.ok) throw new Error(`无法列出 docs/：HTTP ${response.status}`);
  const json = await response.json();
  return json.filter((entry) => entry.type === 'file' && entry.name.endsWith('.md'));
}

/** Extract a one-line summary from the document body. */
function summarize(markdown) {
  const lines = markdown.split('\n');

  // Skip the H1 and any badge/blank lines; take the first real paragraph.
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith('#')) continue;
    if (line.startsWith('[') && line.includes('shields.io')) continue;
    if (line.startsWith('<')) continue;
    if (line.startsWith('```')) break;

    // Join until the paragraph ends, so a wrapped sentence stays whole.
    let text = line;
    let j = i + 1;
    while (j < lines.length && lines[j].trim() && !lines[j].trim().startsWith('#')) {
      text += ` ${lines[j].trim()}`;
      j += 1;
      if (text.length > 220) break;
    }
    return text
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[*_`]/g, '')
      .slice(0, 200)
      .trim();
  }
  return '(无摘要)';
}

/** Keywords that make a document findable, derived from its headings. */
function keywordsOf(markdown, name) {
  const set = new Set(name.split('-').filter((part) => part.length > 2));
  for (const match of markdown.matchAll(/^#{2,3}\s+(.+)$/gm)) {
    const heading = match[1].toLowerCase();
    // Keep short technical headings; skip conversational ones.
    if (heading.length <= 40) {
      for (const word of heading.split(/[\s/()、，,]+/)) {
        if (word.length > 2) set.add(word);
      }
    }
  }
  return [...set].slice(0, 24);
}

async function main() {
  const branch = process.argv[2] ?? 'main';

  console.log(`解析 ${branch} …`);
  const ref = await resolveRef(branch);
  console.log(`pin → ${ref.slice(0, 12)}`);

  const files = await listDocs(ref);
  console.log(`找到 ${files.length} 篇 .md`);

  const docs = [];

  for (const file of files) {
    const url = `https://raw.githubusercontent.com/${REPO}/${ref}/docs/${file.name}`;
    process.stdout.write(`  ${file.name} … `);

    const response = await fetch(url);
    if (!response.ok) {
      console.log(`跳过（HTTP ${response.status}）`);
      continue;
    }
    const body = await response.text();

    docs.push({
      name: file.name.replace(/\.md$/, ''),
      slug: file.name,
      summary: summarize(body),
      keywords: keywordsOf(body, file.name.replace(/\.md$/, '')),
      bytes: file.size,
    });
    console.log('ok');
  }

  docs.sort((a, b) => a.name.localeCompare(b.name));

  const index = {
    repo: REPO,
    ref,
    generatedAt: new Date().toISOString(),
    docs,
  };

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(OUT_FILE, `${JSON.stringify(index, null, 2)}\n`, 'utf8');

  const bytes = Buffer.byteLength(JSON.stringify(index));
  console.log(`\n写入 ${OUT_FILE}`);
  console.log(`${docs.length} 篇，索引 ${(bytes / 1024).toFixed(1)} KB`);
}

main().catch((error) => {
  console.error('失败：', error.message);
  process.exit(1);
});

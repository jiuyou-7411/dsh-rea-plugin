/**
 * Sync the upstream `.agents/skills` tree into vendor/rea-skills.
 *
 * Uses the git tree API rather than walking `contents/`: one recursive request
 * returns every path, and each file is then fetched from its immutable blob URL.
 * The directory walk hit `fetch failed` on the 26 KB SKILL.md during development
 * — likely a transient connection reset on a large-ish sequential download — so
 * this variant retries each blob and reports which ones still failed instead of
 * abandoning the whole skill.
 *
 * Run: node scripts/sync-rea-skills.mjs [ref]
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'vendor', 'rea-skills');

const REPO = 'morluto/rea';
const ROOT = '.agents/skills';

/**
 * Skills that belong in an agent-facing plugin.
 *
 * `reverse-engineer-anything` is the entry point (how to route a request to a
 * provider); the other two explain cost and tool shape. `rea-changelog-update`
 * and `rea-ci-tests-audit` are repo maintenance and would only add noise.
 */
const WANTED = [
  'reverse-engineer-anything',
  'rea-analysis-optimization',
  'rea-tool-design',
];

async function resolveRef(branch) {
  const response = await fetch(`https://api.github.com/repos/${REPO}/commits/${branch}`, {
    headers: { accept: 'application/vnd.github+json' },
  });
  if (!response.ok) throw new Error(`无法解析 ${branch}: HTTP ${response.status}`);
  return (await response.json()).sha;
}

async function treeAt(ref) {
  const response = await fetch(
    `https://api.github.com/repos/${REPO}/git/trees/${ref}?recursive=1`,
    { headers: { accept: 'application/vnd.github+json' } },
  );
  if (!response.ok) throw new Error(`无法读取 tree: HTTP ${response.status}`);
  return (await response.json()).tree;
}

/** One blob, retried. `raw.githubusercontent.com` occasionally resets. */
async function fetchBlob(sha, attempt = 1) {
  const response = await fetch(
    `https://api.github.com/repos/${REPO}/git/blobs/${sha}`,
    { headers: { accept: 'application/vnd.github+json' } },
  );

  if (!response.ok) {
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, 400 * attempt));
      return fetchBlob(sha, attempt + 1);
    }
    throw new Error(`HTTP ${response.status}`);
  }

  const json = await response.json();
  // Blobs come back base64-encoded; text is what these files are.
  return Buffer.from(json.content, json.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');
}

async function main() {
  const branch = process.argv[2] ?? 'main';

  console.log(`解析 ${branch} …`);
  const ref = await resolveRef(branch);
  console.log(`pin → ${ref.slice(0, 12)}\n`);

  const tree = await treeAt(ref);

  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(OUT, { recursive: true });

  const manifest = { repo: REPO, ref, syncedAt: new Date().toISOString(), skills: [] };

  for (const skill of WANTED) {
    const prefix = `${ROOT}/${skill}/`;
    const files = tree.filter(
      (entry) => entry.type === 'blob'
        && entry.path.startsWith(prefix)
        && /\.(md|json|ya?ml|txt)$/i.test(entry.path),
    );

    process.stdout.write(`${skill} … `);

    let written = 0;
    let bytes = 0;
    const failed = [];

    for (const file of files) {
      const relative = file.path.slice(prefix.length);
      const target = path.join(OUT, skill, relative);

      try {
        const text = await fetchBlob(file.sha);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, text, 'utf8');
        written += 1;
        bytes += Buffer.byteLength(text);
      } catch (error) {
        failed.push(`${relative} (${error.message})`);
      }
    }

    if (failed.length > 0) {
      console.log(`${written}/${files.length} 个，失败：${failed.join(', ')}`);
    } else {
      console.log(`${written} 个文件，${(bytes / 1024).toFixed(0)} KB`);
    }

    manifest.skills.push({ name: skill, files: written, bytes, failed });
  }

  await fs.writeFile(
    path.join(OUT, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );

  const totalFiles = manifest.skills.reduce((sum, s) => sum + s.files, 0);
  const totalBytes = manifest.skills.reduce((sum, s) => sum + s.bytes, 0);
  const anyFailed = manifest.skills.some((s) => s.failed.length > 0);

  console.log(`\n共 ${manifest.skills.length} 个技能，${totalFiles} 个文件，${(totalBytes / 1024).toFixed(0)} KB`);
  console.log(`写入 ${OUT}`);
  if (anyFailed) {
    console.log('注意：部分文件未取到，重跑一次通常可补齐。');
  }
}

main().catch((error) => {
  console.error('失败：', error.message);
  process.exit(1);
});

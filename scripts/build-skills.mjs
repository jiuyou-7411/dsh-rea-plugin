/**
 * Turn the vendored `.agents/skills` tree into DSH skill files.
 *
 * The two formats disagree on one important point: upstream skills keep their
 * long-form method in `references/*.md` and expect the agent to open them with a
 * file read; DSH skills are one flat Markdown file each. So this converter
 * *inlines* the references into a single document and keeps the upstream
 * cross-link text intact as headings — the agent reads one file and still gets
 * the whole method.
 *
 * Bodies are capped: `reverse-engineer-anything` is 88 KB inlined and a skill
 * only earns its place in the catalogue if it is cheap enough to load. The cap
 * keeps the router (SKILL.md) plus the first reference, and drops the rest —
 * those remain readable through `rea_docs`, which indexes the same upstream
 * material.
 *
 * Run: node scripts/build-skills.mjs
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'vendor', 'rea-skills');
const OUT = path.join(HERE, '..', 'skills');

/** Per-skill output cap. Above this, the skill stops being cheap to load. */
const MAX_BODY_BYTES = 48 * 1024;

/** Frontmatter for each skill DSH should see. */
const META = {
  'reverse-engineer-anything': {
    name: 'rea',
    description:
      '用 REA 逆向本地二进制、托管程序集、Electron/JavaScript 应用、固件镜像、'
      + '浏览器页面或运行中的进程。当结论依赖「实际产物」而非源码时使用：'
      + '反编译、比较版本、读取运行时证据、还原功能。'
      + '普通源码仓库的架构分析不要用它。',
    whenToUse: '用户要求逆向、反编译、分析 exe/dll/apk/so/固件/Electron/扩展，或问某个程序怎么工作',
  },
  'rea-analysis-optimization': {
    name: 'rea-analysis-optimization',
    description:
      '降低 REA 分析成本的实战方法：什么时候用 CLI 而不是 MCP、如何用 '
      + '--filter-output 裁剪 Evidence、快照复用、provider 选择。'
      + '当一次分析很慢或输出很大时阅读。',
    whenToUse: 'REA 调用很慢、输出过长、token 消耗大，或需要选择 provider',
  },
  'rea-tool-design': {
    name: 'rea-tool-design',
    description:
      'REA 工具的设计原则：为什么是 Evidence 而不是裸结果、覆盖与局限如何标注、'
      + '什么该做成一个工具。扩展 REA 或理解其输出契约时阅读。',
    whenToUse: '编写或修改 REA 工具、理解 Evidence 契约',
  },
};

/** Strip YAML frontmatter and return the body. */
function stripFrontmatter(markdown) {
  if (!markdown.startsWith('---')) return markdown;
  const end = markdown.indexOf('\n---', 3);
  if (end < 0) return markdown;
  return markdown.slice(markdown.indexOf('\n', end + 1) + 1);
}

/** Demote every heading by one level so an inlined file nests under its section. */
function demote(markdown) {
  return markdown.replace(/^(#{1,5})\s/gm, (_, hashes) => `${hashes}# `);
}

async function buildOne(skillName) {
  const meta = META[skillName];
  if (!meta) return null;

  const dir = path.join(SRC, skillName);
  const skillFile = path.join(dir, 'SKILL.md');

  let router;
  try {
    router = await fs.readFile(skillFile, 'utf8');
  } catch {
    console.log(`  跳过 ${skillName}（SKILL.md 不存在）`);
    return null;
  }

  const parts = [stripFrontmatter(router).trim()];
  let bytes = Buffer.byteLength(parts[0]);

  // Append references in name order, stopping at the cap.
  let refDir = [];
  try {
    refDir = (await fs.readdir(path.join(dir, 'references')))
      .filter((name) => name.endsWith('.md'))
      .sort();
  } catch {
    // No references directory.
  }

  for (const name of refDir) {
    const text = await fs.readFile(path.join(dir, 'references', name), 'utf8');
    const title = name.replace(/\.md$/, '').replace(/-/g, ' ');
    const chunk = `\n\n---\n\n## 参考：${title}\n\n${demote(stripFrontmatter(text)).trim()}`;
    const chunkBytes = Buffer.byteLength(chunk);

    if (bytes + chunkBytes > MAX_BODY_BYTES) {
      parts.push(`\n\n---\n\n## 参考：${title}\n\n（篇幅超限未内联。用 rea_docs 查该主题。）`);
      continue;
    }
    parts.push(chunk);
    bytes += chunkBytes;
  }

  const body = parts.join('');

  const frontmatter = [
    '---',
    `name: ${meta.name}`,
    `description: ${meta.description}`,
    meta.whenToUse ? `whenToUse: ${meta.whenToUse}` : null,
    '---',
    '',
  ].filter(Boolean).join('\n');

  return { name: meta.name, content: frontmatter + '\n' + body };
}

async function main() {
  console.log(`读取 ${SRC}`);
  await fs.mkdir(OUT, { recursive: true });

  // Keep the hand-written overview: it covers this plugin's own UI, which
  // upstream knows nothing about.
  const existing = await fs.readdir(OUT).catch(() => []);
  console.log(`现有 skills: ${existing.join(', ') || '(空)'}\n`);

  for (const skillName of Object.keys(META)) {
    process.stdout.write(`${skillName} … `);
    const built = await buildOne(skillName);
    if (!built) continue;

    // The router is the plugin's own entry point and keeps the plain name;
    // the supporting skills are prefixed so they sort together.
    const fileName = built.name === 'rea' ? 'rea.md' : `rea-${built.name}.md`;
    const target = path.join(OUT, fileName);
    await fs.writeFile(target, built.content, 'utf8');
    console.log(`${(Buffer.byteLength(built.content) / 1024).toFixed(0)} KB → ${path.basename(target)}`);
  }

  console.log('\n完成。');
}

main().catch((error) => {
  console.error('失败：', error.message);
  process.exit(1);
});

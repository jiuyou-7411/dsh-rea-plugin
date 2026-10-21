/**
 * Documentation index for the REA project.
 *
 * 72 documents totalling 1.23 MB. Putting them in the prompt is not an option,
 * and neither is putting all 72 titles: the point is that a model should read
 * the *one* document that answers its question, which means it needs a map
 * cheap enough to always be affordable.
 *
 * So this module ships a compact index — topic, one-line summary, and the exact
 * keys a caller would search for — and fetches document bodies on demand from a
 * pinned commit. Nothing is downloaded until asked for.
 *
 * The index is generated, not hand-maintained: `scripts/gen-doc-index.mjs`
 * reads the project's `docs/` directory at a pinned ref and writes
 * `vendor/rea-docs/index.json`. Re-running it is how the index follows an
 * upstream release.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.join(HERE, '..', 'vendor', 'rea-docs', 'index.json');
const DOCS_PATH = path.join(HERE, '..', 'vendor', 'rea-docs', 'docs');


/** Whether the documentation bodies are packaged (offline-ready). */
export function docsAreVendored() {
  return existsSync(path.join(HERE, '..', 'vendor', 'rea-docs', 'VENDORED'));
}

/** Load the generated index. Returns null when the vendor tree is absent. */
export async function loadDocIndex() {
  try {
    const raw = await fs.readFile(INDEX_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Search the index.
 *
 * Substring matching over name + summary + keywords, ranked by where the match
 * lands: a name hit beats a keyword hit, which beats a summary hit. Deliberately
 * not fuzzy — a near-miss would hand the model the wrong document, and reading
 * the wrong 40 KB document costs more than the search saved.
 */
export function searchIndex(index, query, { limit = 8 } = {}) {
  if (!index?.docs?.length) return [];
  const needle = String(query ?? '').trim().toLowerCase();
  if (!needle) {
    return index.docs.slice(0, limit).map((doc) => ({ ...doc, score: 0 }));
  }

  const terms = needle.split(/\s+/).filter(Boolean);

  return index.docs
    .map((doc) => {
      const name = doc.name.toLowerCase();
      const summary = (doc.summary ?? '').toLowerCase();
      const keywords = (doc.keywords ?? []).join(' ').toLowerCase();

      let score = 0;
      for (const term of terms) {
        if (name.includes(term)) score += 10;
        if (keywords.includes(term)) score += 5;
        if (summary.includes(term)) score += 2;
      }
      return { ...doc, score };
    })
    .filter((doc) => doc.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Read one document.
 *
 * Prefers the vendored copy (offline, pinned) and falls back to the network at
 * the indexed ref so a fresh checkout of the plugin still works before the
 * vendor script has run. A `section` argument returns only the matching heading
 * block, which is how a 70 KB document gets used without paying for all of it.
 */
export async function readDoc(index, name, { section = null } = {}) {
  const entry = index?.docs?.find((doc) => doc.name === name || doc.slug === name);
  if (!entry) {
    const available = (index?.docs ?? []).map((doc) => doc.name).join(', ');
    throw new Error(`没有这篇文档：${name}。可用：${available || '(索引为空)'}`);
  }

  // Bodies ship with the plugin: a distributed install must work offline, and a
  // firewall must not turn the documentation into an error message.
  const localPath = path.join(DOCS_PATH, entry.slug);
  if (!existsSync(localPath)) {
    throw new Error(
      `文档正文未随插件分发：${entry.slug}。`
      + '这是打包问题，运行 scripts/vendor-docs.mjs 重新拉取。',
    );
  }
  const text = await fs.readFile(localPath, 'utf8');

  if (!section) return text;

  // Return one heading block: from the matching `## ` heading to the next one.
  const lines = text.split('\n');
  const target = String(section).toLowerCase();
  const start = lines.findIndex((line) => /^#{1,3}\s/.test(line) && line.toLowerCase().includes(target));

  if (start < 0) {
    const headings = lines.filter((line) => /^#{1,3}\s/.test(line)).map((line) => line.trim());
    throw new Error(
      `「${section}」不在 ${entry.slug} 里。可用小节：\n${headings.slice(0, 40).join('\n')}`,
    );
  }

  const level = (lines[start].match(/^#+/) ?? ['#'])[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const match = lines[i].match(/^(#+)\s/);
    if (match && match[1].length <= level) {
      end = i;
      break;
    }
  }

  return lines.slice(start, end).join('\n');
}

/**
 * Build the documentation tool.
 *
 * `action=index` is the cheap map, `action=search` finds a document, and
 * `action=read` returns one document or one section of it.
 */
export function buildDocsTool() {
  return {
    name: 'rea_docs',
    description:
      'REA 官方文档（72 篇，1.2 MB）。先 search 找文档，再 read 读全文或某一节——'
      + '不要一次读全文，用 section 参数只取需要的小节。'
      + '安装、CLI 用法、各引擎（Ghidra/IDA/JEB/Kuna）配置、Android/iOS/固件/'
      + '浏览器/(Electron)/.NET 分析流程、Evidence 与比较契约都在这里。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['index', 'search', 'read'],
          description: 'index=列出全部文档标题；search=按关键词找；read=读文档',
        },
        query: {
          type: 'string',
          description: 'action=search 的关键词，如 "ghidra"、"android"、"evidence"',
        },
        name: {
          type: 'string',
          description: 'action=read 的文档名（不含 .md），如 "cli"、"native-investigation"',
        },
        section: {
          type: 'string',
          description: '只取指定小节（标题关键词），如 "Windows"、"Provider"、"示例"',
        },
      },
      required: ['action'],
    },
    async execute(input = {}) {
      const index = await loadDocIndex();
      if (!index) {
        throw new Error('文档索引缺失（vendor/rea-docs/index.json）。运行 scripts/gen-doc-index.mjs 生成。');
      }

      const action = String(input.action ?? 'index');

      if (action === 'index') {
        const lines = index.docs.map((doc) => `${doc.name.padEnd(40)} ${doc.summary}`);
        return `${index.docs.length} 篇文档（ref ${index.ref ?? '未知'}）：\n\n${lines.join('\n')}`;
      }

      if (action === 'search') {
        const results = searchIndex(index, input.query, { limit: 8 });
        if (results.length === 0) {
          return `没有匹配「${input.query}」的文档。用 action=index 看全部 ${index.docs.length} 篇。`;
        }
        return results
          .map((doc) => `${doc.name}\n  ${doc.summary}`)
          .join('\n\n');
      }

      if (action === 'read') {
        const name = String(input.name ?? '');
        if (!name) throw new Error('action=read 需要 name 参数');
        return readDoc(index, name, { section: input.section ?? null });
      }

      throw new Error(`未知 action：${action}`);
    },
  };
}

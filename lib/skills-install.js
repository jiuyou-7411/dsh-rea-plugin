/**
 * Install this plugin's skills where DSH actually looks for them.
 *
 * Why this exists: a plugin's `skills/*.md` inside its own package is inert. DSH
 * discovers skills from `<projectRoot>/.dsh/skills` and `<projectRoot>/.agents/skills`
 * (see `dsh-skill-filesystem`), and nothing scans a plugin's own directory. So
 * shipping skills in the package without installing them produced a plugin whose
 * four skills never appeared in the catalogue — they were only ever reachable if
 * someone copied them by hand.
 *
 * The install is additive and namespaced: files land under `.dsh/skills/rea/`,
 * a manifest records exactly what was written and its content hash, so:
 *   - a second start with unchanged content writes nothing;
 *   - an upgraded plugin replaces only its own files;
 *   - uninstalling removes only files it can prove it wrote.
 *
 * A file the user edited is left alone and reported, because silently
 * overwriting someone's notes is worse than a stale skill.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_SRC = path.join(HERE, '..', 'skills');

/** Directory name inside `.dsh/skills`. Keeps our files separable from others'. */
const NAMESPACE = 'rea';

/** Manifest file, so uninstall knows exactly what it may delete. */
const MANIFEST = '.manifest.json';

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Locate the project root the way DSH does: walk up from cwd looking for a
 * `.dsh` or `.agents` marker. Falls back to the home directory, which is where a
 * project-less session puts its skills.
 */
function findProjectRoot() {
  let dir = process.cwd();
  const { root } = path.parse(dir);

  for (;;) {
    if (existsSync(path.join(dir, '.dsh')) || existsSync(path.join(dir, '.agents'))) {
      return dir;
    }
    if (dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return os.homedir();
}

/**
 * Every skills root DSH reads, most authoritative first.
 *
 * Two roots exist, and writing only one was a real gap:
 *   <project>/.dsh/skills     source project-dsh, higher rank
 *   <project>/.agents/skills  source project-agents, lower rank
 *
 * The agents tree is the convention the upstream REA project uses for every
 * client it supports, so a skill installed only under .dsh would be invisible to
 * tooling that reads .agents. Writing both keeps the higher-ranked copy
 * authoritative on a name collision while staying discoverable everywhere.
 */
function findSkillsRoots() {
  const project = findProjectRoot();

  return [
    path.join(project, '.dsh', 'skills'),
    path.join(project, '.agents', 'skills'),
  ];
}

/** Read every `.md` in the package's skills directory. */
async function readSources() {
  const sources = [];
  let entries = [];

  try {
    entries = await fs.readdir(SKILLS_SRC);
  } catch {
    return sources;
  }

  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    const text = await fs.readFile(path.join(SKILLS_SRC, name), 'utf8');
    sources.push({ name, text, hash: sha256(text) });
  }

  return sources;
}

/**
 * Install or refresh skills in every root DSH reads.
 *
 * Returns a report rather than throwing: a read-only filesystem should degrade
 * to "skills unavailable" with the reason, not stop the plugin from loading. A
 * root that cannot be written is reported per root, and the others still get the
 * files — a locked `.agents` tree must not cost the `.dsh` copy.
 */
export async function installSkills() {
  const sources = await readSources();
  if (sources.length === 0) {
    return { ok: false, reason: '包内没有 skills/ 目录', written: [], skipped: [], roots: [] };
  }

  const written = [];
  const skipped = [];
  const roots = [];

  for (const root of findSkillsRoots()) {
    const target = path.join(root, NAMESPACE);
    const manifestPath = path.join(target, MANIFEST);

    let previous = { files: {} };
    try {
      previous = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    } catch {
      // First install here, or a manifest we cannot read: treat as empty.
    }

    try {
      await fs.mkdir(target, { recursive: true });
    } catch (error) {
      roots.push({ dir: target, ok: false, reason: error.message });
      continue;
    }

    let wroteHere = 0;

    for (const source of sources) {
      const dest = path.join(target, source.name);
      const previousHash = previous.files?.[source.name];

      // Already ours and unchanged: nothing to do.
      if (previousHash === source.hash && existsSync(dest)) {
        skipped.push({ name: source.name, root: target, reason: 'unchanged' });
        continue;
      }

      // Present but not recorded by us, or recorded with a different hash: the
      // user may have edited it. Report instead of overwriting.
      if (existsSync(dest)) {
        const current = await fs.readFile(dest, 'utf8');
        if (sha256(current) !== source.hash && previousHash !== undefined) {
          skipped.push({ name: source.name, root: target, reason: '本地已修改，保留用户版本' });
          continue;
        }
        if (previousHash === undefined) {
          skipped.push({ name: source.name, root: target, reason: '同名文件不是本插件写入的，跳过' });
          continue;
        }
      }

      try {
        await fs.writeFile(dest, source.text, 'utf8');
        written.push(source.name);
        wroteHere += 1;
      } catch (error) {
        skipped.push({ name: source.name, root: target, reason: error.message });
      }
    }

    // Record what we own here, so a later uninstall can be surgical.
    const files = {};
    for (const source of sources) files[source.name] = source.hash;
    try {
      await fs.writeFile(
        manifestPath,
        `${JSON.stringify({ installedAt: new Date().toISOString(), files }, null, 2)}\n`,
        'utf8',
      );
    } catch {
      // A manifest we cannot write means a later uninstall asks rather than deletes.
    }

    roots.push({ dir: target, ok: true, written: wroteHere });
  }

  const anyOk = roots.some((root) => root.ok);
  return {
    ok: anyOk,
    reason: anyOk ? undefined : roots.map((root) => `${root.dir}: ${root.reason}`).join('; '),
    // Kept for callers that expect one directory; the first writable root.
    dir: roots.find((root) => root.ok)?.dir ?? null,
    written,
    skipped,
    roots,
  };
}

/**
 * Remove only the files this plugin wrote, from every root it wrote to.
 *
 * A file whose hash no longer matches the manifest was edited after install and
 * is kept, because deleting a user's revision is data loss.
 */
export async function uninstallSkills() {
  const removed = [];
  const kept = [];
  const roots = [];

  for (const root of findSkillsRoots()) {
    const target = path.join(root, NAMESPACE);
    const manifestPath = path.join(target, MANIFEST);

    let manifest;
    try {
      manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    } catch {
      // This root was never installed into.
      continue;
    }

    let removedHere = 0;

    for (const [name, hash] of Object.entries(manifest.files ?? {})) {
      const file = path.join(target, name);
      try {
        const current = await fs.readFile(file, 'utf8');
        if (sha256(current) !== hash) {
          kept.push({ name, root: target, reason: '安装后被修改过，保留' });
          continue;
        }
        await fs.unlink(file);
        removed.push(name);
        removedHere += 1;
      } catch {
        // Already gone.
      }
    }

    try {
      await fs.unlink(manifestPath);
      const rest = await fs.readdir(target);
      if (rest.length === 0) await fs.rmdir(target);
    } catch {
      // Directory not empty because the user added files; leave it.
    }

    roots.push({ dir: target, removed: removedHere });
  }

  return {
    ok: removed.length > 0 || roots.length > 0,
    reason: roots.length === 0 ? '没有安装清单，可能从未安装' : undefined,
    removed,
    kept,
    roots,
  };
}

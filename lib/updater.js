/**
 * Update check.
 *
 * A running plugin cannot replace its own files: Node has them open, and on
 * Windows even a rename fails while a module is loaded. So "hot update" here
 * means the part that is actually possible and safe —
 *
 *   1. ask the registry what version exists,
 *   2. compare it against the running one,
 *   3. tell the user, with the exact command to run,
 *   4. let them restart into the new code.
 *
 * What it deliberately does NOT do: download a tarball and overwrite itself.
 * That path needs write access to the DSH profile, leaves a half-updated tree if
 * it fails midway, and produces a plugin whose loaded modules and files disagree
 * — the exact failure mode that makes "it says 2.9.1 but behaves like 2.8.0"
 * bugs. The package manager already does this correctly.
 *
 * Checks are cached and rate-limited: an update check on every panel poll would
 * hit the registry hundreds of times per session for an answer that changes
 * daily.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** How long a registry answer stays valid. Releases rarely ship hourly. */
const CHECK_TTL_MS = 6 * 60 * 60 * 1000;

/** A registry call should never hold up a panel request. */
const CHECK_TIMEOUT_MS = 8000;

/**
 * Where this plugin came from, which decides how it can be updated.
 *
 * `registry`  installed from npm — update with npm
 * `link`      a `link:` or `file:` dependency — a development checkout, and
 *             overwriting a developer's working tree would be destructive
 * `git`       a working copy; git is the right update tool
 */
function installKind() {
  const NAME = 'dsh-rea-plugin';

  try {
    /**
     * Walk up from the running module looking for the manifest that *declares*
     * this plugin as a dependency. That manifest is the DSH profile, and its
     * dependency spec is the only reliable statement of how the plugin got here:
     * `link:` and `file:` mean a local checkout, a version range means the
     * registry.
     *
     * The previous version looked for the old package name and also read `deps`
     * outside its scope, so it always fell through to `unknown`.
     */
    let dir = HERE;
    let spec = null;
    let foundSelf = false;

    for (let i = 0; i < 8; i += 1) {
      const manifest = path.join(dir, 'package.json');
      if (existsSync(manifest)) {
        try {
          const pkg = JSON.parse(readFileSync(manifest, 'utf8'));

          if (pkg.name === NAME) {
            // Our own manifest: keep walking, the profile is further up.
            foundSelf = true;
          } else {
            const deps = {
              ...(pkg.dependencies ?? {}),
              ...(pkg.devDependencies ?? {}),
              ...(pkg.peerDependencies ?? {}),
            };
            if (typeof deps[NAME] === 'string') {
              spec = deps[NAME];
              break;
            }
          }
        } catch {
          // An unreadable manifest is not the profile; keep walking.
        }
      }

      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }

    if (spec !== null) {
      if (spec.startsWith('link:') || spec.startsWith('file:')) {
        return { kind: 'link', detail: spec };
      }
      return { kind: 'registry', detail: spec };
    }

    // No declaring manifest: this is the package directory itself, run directly.
    if (foundSelf || existsSync(path.join(HERE, '..', 'package.json'))) {
      if (existsSync(path.join(HERE, '..', '..', '..', '.git'))) {
        return { kind: 'git', detail: 'git 检出' };
      }
      return { kind: 'self', detail: '运行中的包目录' };
    }

    return { kind: 'unknown', detail: null };
  } catch {
    return { kind: 'unknown', detail: null };
  }
}

/** The version of the installed manifest, read from disk rather than memory. */
function installedVersion() {
  try {
    return JSON.parse(readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

/** Compare two semver strings. Returns -1, 0, or 1; prerelease sorts below release. */
export function compareVersions(a, b) {
  const parse = (value) => {
    const [core, pre] = String(value ?? '0.0.0').split('-');
    const nums = core.split('.').map((part) => Number.parseInt(part, 10) || 0);
    while (nums.length < 3) nums.push(0);
    return { nums, pre: pre ?? null };
  };

  const left = parse(a);
  const right = parse(b);

  for (let i = 0; i < 3; i += 1) {
    if (left.nums[i] !== right.nums[i]) return left.nums[i] > right.nums[i] ? 1 : -1;
  }

  // A release outranks its own prereleases: 1.0.0 > 1.0.0-beta.1
  if (left.pre === right.pre) return 0;
  if (left.pre === null) return 1;
  if (right.pre === null) return -1;
  return left.pre > right.pre ? 1 : -1;
}

/**
 * Ask the registry for the latest published version.
 *
 * `npm view` rather than a bare registry GET because it honours the user's
 * configured registry, proxy, and auth — the same settings that would install
 * the update later.
 */
/**
 * Hard switch for the registry check.
 *
 * Set `REA_UPDATE_CHECK=1` (or pass `updateCheck: true` in the plugin config)
 * to enable it. Off means `status()` answers immediately with
 * `skipped: true` — no process spawn, no timeout, no misleading advice.
 */
let updateCheckEnabled = process.env.REA_UPDATE_CHECK === '1';

/** Flip the switch at runtime, from plugin config. */
export function setUpdateCheckEnabled(enabled) {
  updateCheckEnabled = Boolean(enabled);
}

/** Whether the registry check will actually run. */
export function isUpdateCheckEnabled() {
  return updateCheckEnabled;
}

/**
 * Commit count behind the upstream branch.
 *
 * Uses `git rev-list --count HEAD..@{u}` after a fetch. A missing remote, no
 * network, or a non-checkout all return null rather than a wrong number.
 */
async function gitBehind() {
  const root = path.join(HERE, '..');

  if (!existsSync(path.join(root, '.git'))) return null;

  try {
    await execFileAsync('git', ['fetch', '--quiet'], {
      cwd: root,
      timeout: CHECK_TIMEOUT_MS,
      windowsHide: true,
    });

    const { stdout } = await execFileAsync(
      'git',
      ['rev-list', '--count', 'HEAD..@{u}'],
      { cwd: root, timeout: CHECK_TIMEOUT_MS, windowsHide: true },
    );

    const count = Number.parseInt(String(stdout ?? '0').trim(), 10);
    return Number.isFinite(count) ? count : null;
  } catch {
    // No upstream configured, offline, or not a repository.
    return null;
  }
}

async function fetchLatest() {
  const { stdout } = await execFileAsync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['view', 'dsh-plugin-rea', 'version', '--json'],
    {
      timeout: CHECK_TIMEOUT_MS,
      shell: process.platform === 'win32',
      windowsHide: true,
    },
  );

  const text = String(stdout ?? '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // Some npm versions print the bare string without JSON quoting.
    return text.replace(/^"|"$/g, '');
  }
}

/**
 * The update checker.
 *
 * One instance per plugin, so the cache and any in-flight request are shared by
 * every route and every panel poll.
 */
export class UpdateChecker {
  constructor({ packageName = 'dsh-plugin-rea' } = {}) {
    this.packageName = packageName;
    this.cached = null;
    this.inflight = null;
    this.lastError = null;
  }

  /** Cached answer, or a fresh one if it is stale. Never throws. */
  async status({ force = false } = {}) {
    const now = Date.now();
    const current = installedVersion();
    const kind = installKind();

    /**
     * The registry check is opt-in. Answer immediately when it is off: no
     * spawn, no timeout, and no version comparison against a package that may
     * share this name but not this author.
     */
    if (!updateCheckEnabled) {
      return {
        current,
        latest: null,
        checkedAt: now,
        available: false,
        upToDate: false,
        ahead: false,
        installKind: kind,
        skipped: true,
        gitBehind: await gitBehind(),
        reason: '已关闭 npm 检查（通过 GitHub 分发）',
        error: null,
        command: null,
        hint: kind.kind === 'git' || kind.kind === 'link' || kind.kind === 'self'
          ? '从 GitHub 更新：git pull 后重启 DSH'
          : null,
      };
    }

    if (!force && this.cached && now - this.cached.checkedAt < CHECK_TTL_MS) {
      return this.cached;
    }

    // Collapse concurrent polls onto one registry call.
    if (this.inflight) return this.inflight;

    this.inflight = (async () => {
      let latest = null;
      let error = null;

      try {
        latest = await fetchLatest();
      } catch (failure) {
        // Offline, or the package is not published yet. Both are normal and
        // neither should look like a broken plugin.
        error = failure?.message ?? String(failure);
        error = /E404|404|not found/i.test(error)
          ? '尚未发布到 npm'
          : error.slice(0, 200);
      }

      const comparison = latest && current ? compareVersions(latest, current) : 0;

      const result = {
        current,
        latest,
        checkedAt: now,
        available: comparison > 0,
        upToDate: comparison === 0,
        ahead: comparison < 0,
        installKind: kind,
        error,
        /**
         * The command that actually performs this update on this machine.
         *
         * A linked checkout is refreshed by rebuilding it, not by npm — running
         * the npm command there would replace a developer's source directory
         * with a published tarball.
         */
        command: kind.kind === 'link' || kind.kind === 'self'
          ? null
          : `npm install ${this.packageName}@latest`,
        hint: kind.kind === 'link'
          ? '这是本地开发副本，更新走 git pull 或重新构建'
          : kind.kind === 'self'
            ? '当前是包目录本身，更新请用包管理器重装'
            : null,
      };

      this.cached = result;
      this.lastError = error;
      return result;
    })();

    try {
      return await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  /** Forget the cache so the next call asks again. */
  invalidate() {
    this.cached = null;
  }
}

/**
 * Fingerprint of the shipped skill files.
 *
 * Skills are installed by copying, so a plugin upgrade does not refresh the
 * copies already on disk. Hashing the package's own skills lets the panel say
 * "技能与插件版本不一致，重新部署" instead of leaving the user with a silently
 * stale skill.
 */
export function skillsFingerprint() {
  const dir = path.join(HERE, '..', 'skills');
  const hash = createHash('sha256');
  try {
    const files = readdirSync(dir).filter((n) => n.endsWith('.md')).sort();
    for (const name of files) {
      hash.update(name);
      hash.update(readFileSync(path.join(dir, name), 'utf8'));
    }
    return hash.digest('hex').slice(0, 12);
  } catch {
    return null;
  }
}

/**
 * Pull the plugin's own repository forward.
 *
 * The plugin cannot replace its loaded modules, so this deliberately stops at
 * "the files on disk are now the new version, restart DSH to load them". It is
 * an updater, not a hot-swapper — claiming otherwise would be a lie the user
 * discovers when nothing changes.
 *
 * What it will not do:
 *
 *   - `git reset --hard`, `git clean`, or anything that discards work. If the
 *     working tree is dirty the update refuses and says which files are in the
 *     way, because the person most likely to run this from a checkout is the
 *     person with uncommitted edits.
 *   - `git pull` on a detached HEAD. There is no upstream to merge, and a pull
 *     there either fails confusingly or creates a merge commit nobody asked for.
 *   - Reinstall dependencies. This package declares none (`dependencies: {}`),
 *     so a pull is the whole update. If that ever changes, `needsInstall` below
 *     is the hook.
 *
 * Progress is a single global state object rather than a job map: two
 * concurrent `git pull`s in one working tree would corrupt the index, so the
 * second caller gets the running state instead of a second process.
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Package root — `lib/` sits one level down. */
const ROOT = path.resolve(HERE, '..');

/** A `git pull` that has not finished in this long is not going to. */
const GIT_TIMEOUT_MS = 120_000;

/** Step identifiers, in execution order. The panel renders these as a list. */
export const UPDATE_STEPS = [
  { id: 'inspect', label: '检查仓库状态' },
  { id: 'fetch', label: '查询上游' },
  { id: 'pull', label: '拉取更新' },
  { id: 'verify', label: '确认新版本' },
];

/** The one update in flight, or the last one that ran. */
let state = {
  phase: 'idle', // idle | running | done | failed | skipped
  steps: [],
  startedAt: null,
  finishedAt: null,
  fromVersion: null,
  toVersion: null,
  behind: 0,
  restartRequired: false,
  error: null,
};

function snapshot() {
  return { ...state, steps: state.steps.map((step) => ({ ...step })) };
}

/** Current or last update state. */
export function selfUpdateStatus() {
  return snapshot();
}

/**
 * Run one git command in the package root.
 *
 * `execFile` with an argument array rather than a shell string: the paths here
 * are known, but keeping the shell out of it means no quoting bug can turn a
 * pull into something else.
 */
function git(args, { timeout = GIT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile('git', args, {
      cwd: ROOT,
      timeout,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error?.code ?? 0,
        stdout: (stdout ?? '').trim(),
        stderr: (stderr ?? '').trim(),
        message: error?.message ?? null,
      });
    });
  });
}

function readVersion() {
  try {
    return JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

function setStep(id, patch) {
  const index = state.steps.findIndex((step) => step.id === id);
  if (index === -1) {
    state.steps.push({ id, status: 'pending', detail: null, at: Date.now(), ...patch });
    return;
  }
  state.steps[index] = { ...state.steps[index], ...patch, at: Date.now() };
}

function finish(phase, patch = {}) {
  state = {
    ...state,
    ...patch,
    phase,
    finishedAt: Date.now(),
  };
  return snapshot();
}

/**
 * Pull the repository forward.
 *
 * Returns the final state. Every failure path returns a `phase` and a readable
 * `error` rather than throwing: the caller is an HTTP route whose job is to
 * report, not to crash.
 */
export async function runSelfUpdate({ force = false } = {}) {
  if (state.phase === 'running') return snapshot();

  state = {
    phase: 'running',
    steps: UPDATE_STEPS.map((step) => ({ ...step, status: 'pending', detail: null, at: null })),
    startedAt: Date.now(),
    finishedAt: null,
    fromVersion: readVersion(),
    toVersion: null,
    behind: 0,
    restartRequired: false,
    error: null,
  };

  // ── 1. inspect ──────────────────────────────────────────────────────────
  setStep('inspect', { status: 'running' });

  if (!existsSync(path.join(ROOT, '.git'))) {
    setStep('inspect', { status: 'failed', detail: '不是 git 检出' });
    return finish('failed', { error: '插件目录不是 git 仓库，无法自动更新。请用插件管理器重装。' });
  }

  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branch.ok || branch.stdout === 'HEAD') {
    setStep('inspect', { status: 'failed', detail: '游离 HEAD' });
    return finish('failed', { error: '当前处于游离 HEAD 状态，没有上游分支可拉取。' });
  }

  const dirty = await git(['status', '--porcelain']);
  if (dirty.ok && dirty.stdout) {
    const files = dirty.stdout.split('\n').slice(0, 5).map((line) => line.trim()).join('、');
    setStep('inspect', { status: 'failed', detail: '有未提交的改动' });
    return finish('failed', {
      error: `工作区有未提交的改动（${files}），已停止以免覆盖。`
        + '先提交或撤销这些改动再更新。',
    });
  }

  setStep('inspect', { status: 'done', detail: `分支 ${branch.stdout}` });

  // ── 2. fetch ────────────────────────────────────────────────────────────
  setStep('fetch', { status: 'running' });

  const fetched = await git(['fetch', '--prune', 'origin']);
  if (!fetched.ok) {
    setStep('fetch', { status: 'failed', detail: fetched.stderr || fetched.message });
    return finish('failed', {
      error: `拉取上游失败：${fetched.stderr || fetched.message || '未知错误'}`,
    });
  }

  const behind = await git(['rev-list', '--count', 'HEAD..@{u}']);
  const behindCount = behind.ok ? Number(behind.stdout) || 0 : 0;
  state.behind = behindCount;

  if (behindCount === 0 && !force) {
    setStep('fetch', { status: 'done', detail: '已是最新' });
    setStep('pull', { status: 'skipped', detail: '无需拉取' });
    setStep('verify', { status: 'done', detail: `当前 ${state.fromVersion}` });
    return finish('skipped', {
      toVersion: state.fromVersion,
      error: null,
    });
  }

  setStep('fetch', { status: 'done', detail: `落后 ${behindCount} 个提交` });

  // ── 3. pull ─────────────────────────────────────────────────────────────
  setStep('pull', { status: 'running' });

  // `--ff-only`: if the histories diverged, stop and report rather than
  // producing a merge commit in someone's plugin directory.
  const pulled = await git(['pull', '--ff-only']);
  if (!pulled.ok) {
    setStep('pull', { status: 'failed', detail: pulled.stderr || pulled.message });
    return finish('failed', {
      error: `拉取失败：${pulled.stderr || pulled.message || '未知错误'}`
        + '（本地与上游可能已分叉，需要手动处理）',
    });
  }

  setStep('pull', { status: 'done', detail: pulled.stdout.split('\n')[0] || '已更新' });

  // ── 4. verify ───────────────────────────────────────────────────────────
  setStep('verify', { status: 'running' });

  const toVersion = readVersion();
  state.toVersion = toVersion;

  const changed = toVersion !== state.fromVersion;
  setStep('verify', {
    status: 'done',
    detail: changed ? `${state.fromVersion} → ${toVersion}` : `仍为 ${toVersion}`,
  });

  /*
   * Always ask for a restart, even when the version string did not change: the
   * files on disk are what the next process loads, and a commit that only
   * touched code still needs one. Reporting "no restart needed" because the
   * version was not bumped would leave the user running old modules while
   * believing they had updated.
   */
  return finish('done', { restartRequired: true, error: null });
}

/**
 * Whether the update needs a dependency install afterwards.
 *
 * False today — this package declares no dependencies, so `git pull` is the
 * whole update. Kept as a named export so the day that changes, the caller has
 * one place to look rather than a hardcoded assumption in the route.
 */
export function needsInstall() {
  try {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const deps = { ...(pkg.dependencies ?? {}) };
    return Object.keys(deps).length > 0;
  } catch {
    return false;
  }
}

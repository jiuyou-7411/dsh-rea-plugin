/**
 * First-run provisioning.
 *
 * The plugin is useless until three things exist: the MCP server (npx), the
 * analysis engines, and — for the mobile layer — Python packages. Asking the
 * user to press three buttons after `npm install` is asking them to finish the
 * installation themselves.
 *
 * So activation runs this once. Four rules keep it from being intrusive:
 *
 *  - **Order matters.** The MCP server is what makes tools exist at all, so it
 *    goes first and everything else continues in parallel behind it. JDK comes
 *    before Ghidra because Ghidra refuses to start on Java 17.
 *  - **Only what is missing.** Each step probes first; a satisfied machine does
 *    no work and no downloads.
 *  - **Big and optional by default.** Ghidra is 543 MB and only some users need
 *    native analysis, so it is *not* fetched automatically. It is reported as
 *    available with one click. Everything small enough to be unremarkable —
 *    apktool, JADX, Frida, the seven Python packages — is.
 *  - **Never blocks activation.** `apply()` must return so the Host and the GUI
 *    come up; provisioning runs detached and every failure lands in the health
 *    panel with a reason.
 *
 * The report is kept so `/status` can answer "what did the installer actually
 * do", which is the difference between a silent background task and a
 * diagnosable one.
 */

import { installEngines, probeAll, CACHE_ROOT } from './providers.js';
import { probePython } from './tools-mobile.js';
import { PipRunner } from './python-install.js';
import { findJdk21, installJdk } from './jdk.js';

/**
 * Engines fetched without asking.
 *
 * Ghidra is absent because 543 MB is a decision. Frida is absent because its
 * install writes to the global npm prefix — a machine-wide side effect, and it
 * conflicts with any Frida the user already manages. Both stay one-click.
 *
 * What remains here is small, self-contained inside the plugin cache, and
 * required for the Android path to work at all.
 */
const AUTO_ENGINES = ['apktool', 'jadx'];

/** Hard per-step ceilings, in milliseconds. */
const STEP_TIMEOUT_MS = {
  engines: 15 * 60_000,
  jdk: 15 * 60_000,
  python: 10 * 60_000,
};

/**
 * Run an async step with a deadline.
 *
 * The inner work is given an AbortSignal so a download can cancel cleanly rather
 * than being abandoned mid-write; the timeout reports a distinct reason so the
 * panel can say "timed out" instead of a bare failure.
 */
async function withDeadline(item, run) {
  const limit = STEP_TIMEOUT_MS[item] ?? 10 * 60_000;
  const controller = new AbortController();

  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`${item} 超时（${Math.round(limit / 1000)}s）`));
    }, limit);
  });

  try {
    return await Promise.race([run(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Steps run in this order; each records its own outcome rather than aborting the
 * chain, because a failed JADX install should not stop the Python packages.
 */
export async function provision({ signal, onStep } = {}) {
  const report = {
    startedAt: Date.now(),
    finishedAt: null,
    steps: [],
    skipped: [],
  };

  const record = (step) => {
    report.steps.push(step);
    onStep?.(step);
    return step;
  };

  // ---------------------------------------------------------------------
  // 1. Engines (small ones only)
  // ---------------------------------------------------------------------
  try {
    const before = await probeAll();
    const missing = AUTO_ENGINES.filter(
      (id) => !before.providers.find((provider) => provider.id === id)?.present,
    );

    if (missing.length === 0) {
      report.skipped.push({ item: 'engines', reason: '全部已安装' });
    } else {
      record({ item: 'engines', status: 'running', detail: `安装 ${missing.join(', ')}` });

      const outcome = await installEngines({
        only: missing,
        maxProviderDownloadMb: 2048,
        signal,
      });

      const failed = (outcome.outcomes ?? []).filter((entry) => entry.status !== 'installed');
      record({
        item: 'engines',
        status: failed.length > 0 ? 'partial' : 'done',
        detail: failed.length > 0
          ? `失败：${failed.map((entry) => `${entry.id}(${entry.reason ?? entry.status})`).join(', ')}`
          : `已装 ${missing.join(', ')}`,
      });
    }
  } catch (error) {
    record({ item: 'engines', status: 'error', detail: error?.message ?? String(error) });
  }

  // ---------------------------------------------------------------------
  // 2. JDK 21 (only when Ghidra is wanted and the system Java is too old)
  // ---------------------------------------------------------------------
  try {
    const jdk = await findJdk21();
    if (jdk.sufficient) {
      report.skipped.push({
        item: 'jdk',
        reason: `已有 Java ${jdk.major}（${jdk.source}）`,
      });
    } else if (!jdk.present) {
      // No Java at all: JADX and apktool also need one, so this is worth doing.
      record({ item: 'jdk', status: 'running', detail: '安装私有 JDK 21' });
      await installJdk({ signal });
      record({ item: 'jdk', status: 'done', detail: '已安装私有 JDK 21' });
    } else {
      // Java exists but is older than 21. Installing a second JDK only matters
      // once Ghidra is wanted, so leave the choice to the user.
      report.skipped.push({
        item: 'jdk',
        reason: `系统 Java ${jdk.major} < 21；装 Ghidra 时需要，可在面板一键安装`,
      });
    }
  } catch (error) {
    record({ item: 'jdk', status: 'error', detail: error?.message ?? String(error) });
  }

  // ---------------------------------------------------------------------
  // 3. Python packages for the MobileRE layer
  // ---------------------------------------------------------------------
  try {
    const python = await probePython();
    if (!python.present) {
      report.skipped.push({ item: 'python', reason: '未找到 Python 3' });
    } else if ((python.missing ?? []).length === 0) {
      report.skipped.push({ item: 'python', reason: '7 个依赖已齐全' });
    } else {
      // probePython already reports import names, which is exactly what the
      // installer accepts; it translates to pip names itself.
      const missingPip = python.missing ?? [];
      record({
        item: 'python',
        status: 'running',
        detail: `安装 ${missingPip.length} 个包`,
      });

      const installer = new PipRunner({
        python: python.command,
        packages: missingPip.map((name) => (name === 'elftools' ? 'pyelftools' : (name === 'z3' ? 'z3-solver' : name))),
      });
      const result = await installer.install({ signal });

      record({
        item: 'python',
        status: 'done',
        detail: `已装 ${result.mirror?.label ?? '镜像'}`,
      });
    }
  } catch (error) {
    record({ item: 'python', status: 'error', detail: error?.message ?? String(error) });
  }

  report.finishedAt = Date.now();
  return report;
}

/**
 * Ghidra is reported, never auto-installed.
 *
 * 543 MB is a decision, not a default. The panel shows it as "可安装" with its
 * size, and `rea_provider_install` can fetch it when asked.
 */
export function ghidraStatus(report) {
  const outcome = report.steps.find((step) => step.item === 'engines');
  return {
    autoInstalled: false,
    sizeMb: 543,
    reason: '需要 543 MB 下载和 JDK 21；桌面面板可一键安装',
    enginesDir: CACHE_ROOT,
    engineStep: outcome ?? null,
  };
}

/** One-line summary for the activation log. */
export function summarize(report) {
  const done = report.steps.filter((step) => step.status === 'done').length;
  const failed = report.steps.filter((step) => step.status !== 'done' && step.status !== 'running').length;
  const skipped = report.skipped.length;
  const ms = (report.finishedAt ?? Date.now()) - report.startedAt;
  return `已装 ${done} 项，跳过 ${skipped} 项，失败 ${failed} 项，耗时 ${(ms / 1000).toFixed(1)}s`;
}

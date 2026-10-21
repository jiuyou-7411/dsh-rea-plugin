/**
 * Host HTTP API for the REA workbench.
 *
 * The panel is a Client module and cannot call Host services directly, so the
 * supported bridge is a `webServer.register` route. Routes:
 *
 *   GET  /status             engine readiness + capability matrix
 *   GET  /health             service health overview (MCP, engines, Node, errors)
 *   GET  /metrics            telemetry aggregate: counts, slowest, failing, errors
 *   GET  /events             live tool-call stream (poll or SSE)
 *   POST /install            start an install job, return its id
 *   GET  /job?id=            poll one job's progress
 *   POST /control            pause or resume a job
 *   POST /cancel             abandon a job
 *   GET  /uninstall-preview  what an uninstall would free
 *   POST /uninstall          remove plugin-managed engines
 *
 * Install is asynchronous on purpose. A 543 MiB download takes minutes, and a
 * single request held open for that long would be killed by proxy or browser
 * timeouts and could not report progress. A job id plus polling keeps the
 * transfer alive and gives the panel a number to render.
 *
 * One install runs at a time process-wide: two concurrent engines would compete
 * for the same archive directory and the same CPU during extraction.
 */

import { randomUUID } from 'node:crypto';
import {
  probeAll,
  installEngines,
  inspectUninstall,
  uninstallEngines,
  providerEnvironment,
  CACHE_ROOT,
} from './providers.js';
import { buildHealth } from './health.js';
import { probePython, vendorInventory } from './tools-mobile.js';
import {
  findJdk21, installJdk, uninstallJdk, jdkDirectorySize, REQUIRED_JAVA,
} from './jdk.js';
import { UpdateChecker, skillsFingerprint } from './updater.js';
import {
  PipRunner, PYTHON_PACKAGES, packageInventory, pipNameOf, packageInfo, InstallAborted,
} from './python-install.js';

/** Cap on a request body, so a malformed client cannot grow memory unboundedly. */
const MAX_BODY_BYTES = 16 * 1024;

/** How long a finished job stays addressable, so a poller can read the end state. */
const JOB_RETENTION_MS = 10 * 60 * 1000;

/**
 * Live jobs by id. Each entry holds the state the panel polls plus an abort
 * controller so a cancellation actually stops the transfer.
 */
const jobs = new Map();

/**
 * Python dependency install job.
 *
 * Separate from the engine jobs table because the lifecycle differs: an engine
 * job resolves N downloadable assets, this one runs a single pip process.
 * Keeping them apart avoids teaching `startJob` about a job shape it cannot
 * model.
 */
let pythonJob = null;

/**
 * JDK provisioning job.
 *
 * A separate table from the engines because the lifecycle and the payload are
 * different: one ~180 MB archive, one progress stream, and a global Java version
 * check afterwards rather than a per-engine readiness matrix.
 */
let jdkJob = null;

/**
 * Last real JDK probe, reused while a download runs.
 *
 * Walking a 523 MB tree on every poll would starve the disk; the job's own
 * counters are what the panel needs during a download anyway.
 */
let lastJdkProbe = null;
let lastJdkSizeMb = 0;

/**
 * One checker per process: the registry answer is cached for hours, and every
 * panel poll reads the same result.
 */
const updater = new UpdateChecker({ packageName: 'dsh-rea-plugin' });

/**
 * Mirrors tried before the official index.
 *
 * The official index served frida's 58 MB wheel at a few KB/s during
 * development and timed out twice; the Tsinghua mirror delivered it at
 * 72 MB/s. The official index stays as a fallback so a machine outside
 * mainland China still installs normally.
 */
const PIP_MIRRORS = [
  'https://pypi.tuna.tsinghua.edu.cn/simple',
  'https://mirrors.aliyun.com/pypi/simple',
];

function pruneJobs() {
  const cutoff = Date.now() - JOB_RETENTION_MS;
  for (const [id, job] of jobs) {
    if (job.finishedAt && job.finishedAt < cutoff) jobs.delete(id);
  }
}

async function readJsonBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new Error(`请求体超过 ${MAX_BODY_BYTES} 字节`);
    chunks.push(chunk);
  }
  if (total === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

/**
 * Assemble the panel's view: engine readiness and target-family capability.
 * Both are computed together because the panel renders them in one grid, and a
 * user asking "can I analyse an APK" needs the engine row and the family row to
 * agree.
 */
async function buildStatus(config) {
  const report = await probeAll();
  // Probing Python spawns a process (~100 ms on Windows), so it is cached for
  // a short window: the panel polls /status while a bridge starts.
  const python = await probePythonCached(config?.pythonPath);
  const has = (id) => report.providers.some((provider) => provider.id === id && provider.present);
  const isMac = process.platform === 'darwin';

  /**
   * `blocked` separates a family this host can never run from one that is merely
   * missing an engine. Without it the panel showed "6 / 8" on Windows and implied
   * two installs would reach 8, when Hopper cannot exist off macOS at all.
   * `fixable` counts the blocked-by-engine ones, which the Install button can
   * actually resolve.
   */
  const targets = [
    { family: 'javascript-electron', label: 'JavaScript / Electron / web', ready: true, engine: 'built-in' },
    { family: 'artifacts', label: 'Archives, packages, plist, sqlite', ready: true, engine: 'built-in' },
    { family: 'managed-dotnet', label: '.NET / PE-CLI assemblies', ready: true, engine: 'built-in' },
    {
      family: 'native-decompile',
      label: 'Native decompile, xrefs, value flow',
      ready: has('ghidra'),
      engine: 'ghidra',
      blocked: false,
      fixableBy: has('ghidra') ? null : 'ghidra',
    },
    {
      family: 'android',
      label: 'Android APK decompile',
      ready: has('jadx') && report.java.present,
      engine: 'jadx + java',
      blocked: false,
      fixableBy: has('jadx') && report.java.present ? null : (report.java.present ? 'jadx' : 'java'),
    },
    {
      family: 'android-dynamic',
      label: 'Android dynamic (Frida)',
      ready: has('frida'),
      engine: 'frida',
      blocked: false,
      fixableBy: has('frida') ? null : 'frida',
    },
    { family: 'firmware', label: 'Firmware images', ready: true, engine: 'built-in' },
    {
      family: 'apple-native',
      label: 'Apple native tooling (Hopper)',
      ready: isMac,
      engine: 'macOS only',
      // A platform limitation, not a missing install: the panel must not offer
      // a fix for it or count it against the user's setup.
      blocked: !isMac,
      note: isMac ? null : `需要 macOS，当前是 ${process.platform}`,
    },
  ];

  const activeJob = [...jobs.values()].find((job) => !job.finishedAt && !job.paused) ?? null;

  /**
   * Capability counts the panel can show without arithmetic of its own.
   *
   * `reachable` is the honest denominator: the families this host could ever
   * run, excluding platform-blocked ones. On Windows that is 7, not 8, so a
   * fully installed setup reads 7 / 7 rather than 7 / 8 with a permanent gap.
   */
  const reachable = targets.filter((target) => !target.blocked);
  const readyTargets = targets.filter((target) => target.ready);

  const mcpStatus = config?.mcpStatus?.() ?? { state: 'unavailable', toolCount: 0 };

  /**
   * The Host's registered tool names, grouped.
   *
   * `config.listToolNames` is supplied by index.js because the tool registry
   * lives there; this module never held a reference to it.
   */
  const toolNames = typeof config?.listToolNames === 'function' ? config.listToolNames() : [];
  const toolCounts = {
    total: toolNames.length,
    rea: toolNames.filter((name) => name.startsWith('mcp__rea__')).length,
    mobile: toolNames.filter((name) => name.startsWith('mobile_')).length,
    local: toolNames.filter((name) => !name.startsWith('mcp__rea__') && !name.startsWith('mobile_')).length,
  };

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    /**
     * The in-process MCP bridge. State is idle / starting / ready / error /
     * stopped, and the error field carries the reason when it is not ready —
     * that string is what makes a failed start visible instead of a silently
     * empty tool list.
     */
    mcp: mcpStatus,
    /** Convenience mirrors of mcp.toolCount, so the panel reads one field. */
    /**
     * Tool totals, split so the panel can say what the 218 is made of.
     *
     * `toolCount` alone was misleading: it reported only the MCP half (207) and
     * left the six MobileRE tools and five local helpers invisible, so a
     * correctly-loaded plugin looked like it had lost them.
     */
    toolCount: toolCounts.total,
    toolBreakdown: toolCounts,
    platform: `${process.platform}/${process.arch}`,
    node: process.version,
    reaVersion: config?.reaVersion ?? null,
    cacheRoot: CACHE_ROOT,
    java: report.java,
    /** Python runtime the MobileRE scripts need; missing packages are named. */
    python,
    /** What the vendored MobileRE tree actually contains. */
    mobilere: vendorInventory(),
    /**
     * What the automatic first-run provisioning actually did.
     *
     * Present so "the plugin installed itself" is verifiable rather than
     * asserted: each step carries its own outcome, and a skipped step says why.
     */
    provision: typeof config?.provisionStatus === 'function'
      ? config.provisionStatus()
      : null,
    providers: report.providers,
    targets,
    environment: providerEnvironment(),
    readyCount: report.providers.filter((provider) => provider.present).length,
    totalCount: report.providers.length,
    targetReadyCount: readyTargets.length,
    targetReachableCount: reachable.length,
    targetBlockedCount: targets.filter((target) => target.blocked).length,
    // Families an install could still unlock, so the panel can say "1 项可修复"
    // instead of implying the missing ones are all actionable.
    targetFixableCount: targets.filter((target) => !target.ready && !target.blocked).length,
    activeJob: activeJob ? { id: activeJob.id, startedAt: activeJob.startedAt } : null,
  };
}

/** Python probe cache: 60 s is short enough to notice a pip install. */
let pythonCache = { at: 0, value: null };
async function probePythonCached(pythonPath) {
  const now = Date.now();
  if (pythonCache.value && now - pythonCache.at < 60_000) return pythonCache.value;
  const value = await probePython(pythonPath);
  pythonCache = { at: now, value };
  return value;
}

/** Start an install job and return immediately with its id. */
function startJob(only, config) {
  pruneJobs();

  // A paused job occupies no download bandwidth and holds no live controller,
  // so a new install may start; its partial files are shared state the new run
  // simply resumes from. Only a genuinely running job blocks.
  const running = [...jobs.values()].find((job) => !job.finishedAt && !job.paused);
  if (running) {
    return { error: 'job-running', jobId: running.id };
  }

  const controller = new AbortController();
  const id = randomUUID();

  const job = {
    id,
    startedAt: Date.now(),
    finishedAt: null,
    only: only ?? null,
    controller,
    // Per-engine progress, keyed by engine id, so the panel can render one bar
    // per card instead of a single global bar.
    engines: {},
    phase: 'starting',
    outcomes: null,
    error: null,
    /**
     * Pause is distinct from cancel. A paused job stops transferring but keeps
     * its `.partial` files, so `resume` re-enters the same engine list and the
     * downloader continues from the byte it reached. Cancel would be the same
     * abort with the caller declining to resume.
     */
    paused: false,
    pausedAt: null,
    /** Engines the job was asked to install, preserved across a resume. */
    requested: only ?? null,
  };
  jobs.set(id, job);

  const maxProviderDownloadMb = Number(config?.maxProviderDownloadMb ?? 2048);
  job.maxProviderDownloadMb = maxProviderDownloadMb;

  // Fire and forget: the caller polls. Errors are recorded on the job, never
  // thrown into the request that started it.
  (async () => {
    try {
      const result = await installEngines({
        only,
        maxProviderDownloadMb,
        signal: controller.signal,
        onProgress: (progress) => {
          job.phase = progress.phase;
          const current = job.engines[progress.id] ?? { percent: 0 };
          job.engines[progress.id] = {
            ...current,
            phase: progress.phase,
            percent: progress.percent ?? current.percent ?? 0,
            received: progress.received ?? current.received ?? null,
            total: progress.total ?? current.total ?? null,
            bytesPerSecond: progress.bytesPerSecond ?? null,
            file: progress.file ?? current.file ?? null,
            message: progress.message ?? current.message ?? null,
          };
        },
      });

      // A pause arrives as an abort, so the outcome list holds `cancelled`
      // entries. Recording them as a finished success would misreport what the
      // user asked for, so the job keeps a distinct paused phase instead.
      job.outcomes = result.outcomes;
      job.environment = result.environment;
      job.phase = job.paused ? 'paused' : 'finished';
    } catch (error) {
      if (job.paused) {
        job.phase = 'paused';
      } else {
        job.error = error?.message ?? String(error);
        job.phase = 'failed';
      }
    } finally {
      job.finishedAt = Date.now();
      // Release the memory of a large install now; polling only needs the
      // summary. `resume` installs a fresh controller.
      job.controller = null;
    }
  })();

  return { jobId: id };
}

/**
 * Pause or resume one job in place.
 *
 * Pause aborts the transfer but keeps every `.partial` file, so a later resume
 * continues from the byte offset already reached — a 543 MiB Ghidra download
 * interrupted at 400 MiB does not restart at zero.
 *
 * Resume is only meaningful for a paused job: a running job is rejected, and a
 * finished one has nothing left to continue.
 */
function controlJob(id, action) {
  const job = jobs.get(id);
  if (!job) return { error: 'job-not-found' };

  if (action === 'pause') {
    if (job.finishedAt) return { error: 'job-not-running' };
    if (job.paused) return { ok: true, already: 'paused' };
    job.paused = true;
    job.pausedAt = Date.now();
    job.controller?.abort();
    return { ok: true };
  }

  if (action === 'resume') {
    // A paused job is also finished: the transfer loop exits on abort. So the
    // gate is `paused`, not `finishedAt`, and resume reopens the job.
    if (!job.paused) return { error: 'not-paused' };

    // Hand back a fresh controller and continue in place, so the panel keeps
    // polling the same id and the completed engines stay marked done.
    const controller = new AbortController();
    job.controller = controller;
    job.paused = false;
    job.pausedAt = null;
    job.finishedAt = null;
    job.phase = 'starting';

    // Only engines that are not already installed are re-attempted; the ones
    // that finished before the pause must not download again.
    const pending = (job.requested ?? null)
      ?? Object.keys(job.engines).filter((engineId) => job.engines[engineId]?.phase !== 'done');

    for (const engineId of Object.keys(job.engines)) {
      if (job.engines[engineId]?.phase === 'done') continue;
      // Keep the byte total for the bar, but reset the transient phase so the
      // panel shows the retry rather than a stale "download".
      job.engines[engineId] = { ...job.engines[engineId], phase: 'queued', bytesPerSecond: null };
    }

    (async () => {
      try {
        const result = await installEngines({
          only: pending.length > 0 ? pending : undefined,
          maxProviderDownloadMb: Number(job.maxProviderDownloadMb ?? 2048),
          signal: controller.signal,
          onProgress: (progress) => {
            job.phase = progress.phase;
            const current = job.engines[progress.id] ?? { percent: 0 };
            job.engines[progress.id] = {
              ...current,
              phase: progress.phase,
              percent: progress.percent ?? current.percent ?? 0,
              received: progress.received ?? current.received ?? null,
              total: progress.total ?? current.total ?? null,
              bytesPerSecond: progress.bytesPerSecond ?? null,
              file: progress.file ?? current.file ?? null,
              message: progress.message ?? current.message ?? null,
            };
          },
        });
        job.outcomes = result.outcomes;
        job.environment = result.environment;
        job.phase = job.paused ? 'paused' : 'finished';
      } catch (error) {
        if (job.paused) job.phase = 'paused';
        else {
          job.error = error?.message ?? String(error);
          job.phase = 'failed';
        }
      } finally {
        job.finishedAt = Date.now();
        job.controller = null;
      }
    })();

    return { ok: true, resumed: pending };
  }

  return { error: 'unknown-action' };
}

export function createApiRoutes(config) {
  const disposers = [];
  /** Telemetry and the tool registry are injected by index.js at attach time. */
  let telemetry = null;
  let toolsRef = null;

  /**
   * Start (or restart) the in-process MCP bridge.
   *
   * The companion to `/status`: a failed start is reported there, and this is
   * the one click that fixes it without editing a profile or restarting the
   * Host. Idempotent — calling it while ready just returns the tool count.
   */
  const mcpStartRoute = {
    method: 'POST',
    path: '/api/dsh-plugin-rea/mcp/start',
    async handler(request, response) {
      try {
        if (typeof config?.startMcp !== 'function') {
          sendJson(response, 503, { ok: false, error: 'MCP 桥未在当前组合中启用' });
          return;
        }
        const result = await config.startMcp();
        if (!result.ok) {
          sendJson(response, 502, { ok: false, error: result.error });
          return;
        }
        sendJson(response, 200, {
          ok: true,
          toolCount: result.toolCount,
          status: config.mcpStatus?.() ?? null,
        });
      } catch (error) {
        sendJson(response, 500, { ok: false, error: error?.message ?? String(error) });
      }
    },
  };


  // -------------------------------------------------------------------------
  // Python dependencies (MobileRE)
  //
  // Same shape as the engine install: POST starts a job, GET polls it. The
  // payload differs because pip reports per-package progress rather than byte
  // counts, and because a mirror can be chosen before the run.
  // -------------------------------------------------------------------------

  /** What the install would cost, so the confirm dialog can name the number. */
  /**
   * Update state: what is running, what exists upstream, and how to get there.
   *
   * The plugin cannot replace its own files while Node holds them open, so this
   * reports the gap and the exact command instead of pretending to self-update.
   * `?force=1` bypasses the six-hour cache after the user acts on a notice.
   */
  const updateRoute = {
    method: 'GET',
    path: '/api/dsh-plugin-rea/update',
    async handler(request, response) {
      try {
        const url = new URL(request.url, 'http://localhost');
        const force = url.searchParams.get('force') === '1';
        const status = await updater.status({ force });
        sendJson(response, 200, {
          ok: true,
          ...status,
          skillsFingerprint: skillsFingerprint(),
        });
      } catch (error) {
        sendJson(response, 500, { ok: false, error: error?.message ?? String(error) });
      }
    },
  };

  /**
   * JDK state: what is installed, whether it satisfies Ghidra, and whether a
   * private copy lives in the plugin cache.
   */
  const jdkStatusRoute = {
    method: 'GET',
    path: '/api/dsh-plugin-rea/jdk',
    async handler(request, response) {
      try {
        /**
         * An in-flight job changes the shape of this answer.
         *
         * The full response probes Java and walks a 523 MB directory to total it
         * up. Running that on every 600 ms poll means traversing the tree ~100
         * times a minute, which starves the disk and makes the panel look frozen
         * exactly when it should feel alive.
         *
         * So while a job runs, report the job's own counters and reuse the last
         * probe; reserve the expensive walk for load and for the tick after the
         * job settles.
         */
        if (jdkJob && !jdkJob.finishedAt) {
          sendJson(response, 200, {
            ok: true,
            jdk: lastJdkProbe,
            requiredMajor: REQUIRED_JAVA,
            privateSizeMb: lastJdkSizeMb,
            hasPrivateCopy: lastJdkSizeMb > 0,
            job: {
              id: jdkJob.id,
              phase: jdkJob.phase,
              percent: jdkJob.percent,
              received: jdkJob.received,
              total: jdkJob.total,
              bytesPerSecond: jdkJob.bytesPerSecond,
              source: jdkJob.source,
              error: jdkJob.error,
              done: false,
            },
          });
          return;
        }

        const jdk = await findJdk21();
        const sizeBytes = await jdkDirectorySize();
        lastJdkProbe = jdk;
        lastJdkSizeMb = Math.round(sizeBytes / 1048576);

        sendJson(response, 200, {
          ok: true,
          jdk,
          requiredMajor: REQUIRED_JAVA,
          privateSizeMb: lastJdkSizeMb,
          hasPrivateCopy: sizeBytes > 0,
          job: jdkJob
            ? {
              id: jdkJob.id,
              phase: jdkJob.phase,
              percent: jdkJob.percent,
              received: jdkJob.received,
              total: jdkJob.total,
              bytesPerSecond: jdkJob.bytesPerSecond,
              source: jdkJob.source,
              error: jdkJob.error,
              done: Boolean(jdkJob.finishedAt),
            }
            : null,
        });
      } catch (error) {
        sendJson(response, 500, { ok: false, error: error?.message ?? String(error) });
      }
    },
  };

  const jdkInstallRoute = {
    method: 'POST',
    path: '/api/dsh-plugin-rea/jdk/install',
    async handler(request, response) {
      try {
        if (jdkJob && !jdkJob.finishedAt) {
          sendJson(response, 409, { ok: false, error: 'job-running', jobId: jdkJob.id });
          return;
        }

        const controller = new AbortController();
        const id = randomUUID();

        jdkJob = {
          id,
          startedAt: Date.now(),
          finishedAt: null,
          controller,
          phase: 'download',
          percent: 0,
          received: 0,
          total: 0,
          bytesPerSecond: 0,
          source: null,
          error: null,
        };

        void installJdk({
          signal: controller.signal,
          onProgress: (progress) => {
            if (!jdkJob) return;
            jdkJob.phase = progress.phase;
            if (progress.received !== undefined) jdkJob.received = progress.received;
            if (progress.total !== undefined) jdkJob.total = progress.total;
            if (progress.percent !== undefined) jdkJob.percent = progress.percent;
            if (progress.bytesPerSecond !== undefined) jdkJob.bytesPerSecond = progress.bytesPerSecond;
            if (progress.source !== undefined) jdkJob.source = progress.source;
          },
        })
          .then(() => {
            if (!jdkJob) return;
            jdkJob.finishedAt = Date.now();
            jdkJob.phase = 'done';
            jdkJob.percent = 100;
          })
          .catch((error) => {
            if (!jdkJob) return;
            jdkJob.finishedAt = Date.now();
            jdkJob.phase = 'error';
            jdkJob.error = error?.message ?? String(error);
          });

        sendJson(response, 202, { ok: true, jobId: id });
      } catch (error) {
        sendJson(response, 400, { ok: false, error: error?.message ?? String(error) });
      }
    },
  };

  const jdkUninstallRoute = {
    method: 'POST',
    path: '/api/dsh-plugin-rea/jdk/uninstall',
    async handler(request, response) {
      try {
        const result = await uninstallJdk();
        sendJson(response, 200, { ok: true, ...result });
      } catch (error) {
        sendJson(response, 400, { ok: false, error: error?.message ?? String(error) });
      }
    },
  };

  /**
   * Per-package state: present or not, version, disk size, and which scripts
   * need it. This is the payload the panel renders one row per package from.
   */
  const pythonPreviewRoute = {
    method: 'GET',
    path: '/api/dsh-plugin-rea/python/packages',
    async handler(request, response) {
      try {
        const probe = await probePythonCached(config?.pythonPath);
        const inventory = probe.present ? await packageInventory(probe.command) : {};

        const rows = PYTHON_PACKAGES.map((entry) => {
          const found = inventory[entry.importName] ?? null;
          return {
            importName: entry.importName,
            pipName: entry.pipName,
            label: entry.label,
            purpose: entry.purpose,
            usedBy: entry.usedBy,
            sizeMb: entry.sizeMb,
            present: Boolean(found),
            version: found?.version ?? null,
            installedMb: found?.sizeMb ?? null,
            path: found?.path ?? null,
          };
        });

        sendJson(response, 200, {
          ok: true,
          python: {
            present: probe.present,
            version: probe.version,
            command: probe.command,
            error: probe.error ?? null,
          },
          packages: rows,
          installed: rows.filter((r) => r.present).length,
          total: rows.length,
          missingMb: rows.filter((r) => !r.present).reduce((sum, r) => sum + r.sizeMb, 0),
          mirrors: PIP_MIRRORS,
        });
      } catch (error) {
        sendJson(response, 500, { ok: false, error: error?.message ?? String(error) });
      }
    },
  };

  /**
   * Start a pip job for specific packages (install or uninstall).
   *
   * Single-package granularity on purpose: the panel offers one button per row,
   * so a failed build or a version conflict is isolated instead of forcing the
   * user to reinstall all seven.
   */
  const pythonInstallRoute = {
    method: 'POST',
    path: '/api/dsh-plugin-rea/python/install',
    async handler(request, response) {
      try {
        if (pythonJob && !pythonJob.finishedAt) {
          sendJson(response, 409, { ok: false, error: 'job-running', jobId: pythonJob.id });
          return;
        }

        const probe = await probePythonCached(config?.pythonPath);
        if (!probe.present) {
          sendJson(response, 400, { ok: false, error: probe.error ?? '未找到 Python 解释器' });
          return;
        }

        const body = await readJsonBody(request);
        const action = body.action === 'uninstall' ? 'uninstall' : 'install';

        // `only` carries import names (what the panel knows); pip needs pip
        // names, which differ for pyelftools and z3-solver.
        const selected = Array.isArray(body.only) && body.only.length > 0
          ? body.only
          : (action === 'install' ? (probe.missing ?? []) : []);

        if (selected.length === 0) {
          sendJson(response, 200, { ok: true, nothingToDo: true });
          return;
        }

        const pipNames = selected.map((name) => pipNameOf(name));
        const runner = new PipRunner({ python: probe.command, mirror: body.mirror ?? null });
        const controller = new AbortController();
        const id = randomUUID();

        pythonJob = {
          id,
          action,
          startedAt: Date.now(),
          finishedAt: null,
          paused: false,
          controller,
          runner,
          scope: pipNames,
          phase: 'starting',
          package: null,
          done: 0,
          total: pipNames.length,
          percent: 0,
          log: [],
          mirror: null,
          error: null,
        };

        runner.on('progress', (progress) => {
          if (!pythonJob) return;
          pythonJob.phase = progress.phase;
          pythonJob.package = progress.package;
          pythonJob.done = progress.done;
          pythonJob.total = progress.total;
          pythonJob.percent = progress.percent;
        });

        runner.on('log', (entry) => {
          if (!pythonJob) return;
          pythonJob.log.push(entry);
          if (pythonJob.log.length > 200) pythonJob.log.shift();
        });

        const run = action === 'uninstall'
          ? runner.uninstall(pipNames, { signal: controller.signal })
          : runner.install(pipNames, { signal: controller.signal });

        void run
          .then((result) => {
            if (!pythonJob) return;
            pythonJob.finishedAt = Date.now();
            pythonJob.phase = 'done';
            pythonJob.percent = 100;
            if (result?.mirror) pythonJob.mirror = result.mirror;
            // Any package change invalidates the probe cache.
            pythonCache = { at: 0, value: null };
          })
          .catch((error) => {
            if (!pythonJob) return;
            pythonJob.finishedAt = Date.now();
            if (error instanceof InstallAborted) {
              pythonJob.phase = error.reason === 'pause' ? 'paused' : 'cancelled';
            } else {
              pythonJob.phase = 'error';
              pythonJob.error = error?.message ?? String(error);
            }
            pythonCache = { at: 0, value: null };
          });

        sendJson(response, 202, { ok: true, jobId: id, action, packages: pipNames });
      } catch (error) {
        sendJson(response, 400, { ok: false, error: error?.message ?? String(error) });
      }
    },
  };

  const pythonJobRoute = {
    method: 'GET',
    path: '/api/dsh-plugin-rea/python/job',
    async handler(request, response) {
      try {
        const url = new URL(request.url, 'http://localhost');
        const id = url.searchParams.get('id');

        if (!pythonJob) {
          sendJson(response, 404, { ok: false, error: 'no-job' });
          return;
        }
        if (id && id !== pythonJob.id) {
          sendJson(response, 404, { ok: false, error: 'unknown-job' });
          return;
        }

        sendJson(response, 200, {
          ok: true,
          id: pythonJob.id,
          action: pythonJob.action,
          scope: pythonJob.scope,
          phase: pythonJob.phase,
          package: pythonJob.package,
          done: pythonJob.done,
          total: pythonJob.total,
          percent: pythonJob.percent,
          paused: pythonJob.paused,
          error: pythonJob.error,
          mirror: pythonJob.mirror ?? null,
          log: pythonJob.log.slice(-40),
          done_flag: Boolean(pythonJob.finishedAt),
        });
      } catch (error) {
        sendJson(response, 500, { ok: false, error: error?.message ?? String(error) });
      }
    },
  };

  const pythonControlRoute = {
    method: 'POST',
    path: '/api/dsh-plugin-rea/python/control',
    async handler(request, response) {
      try {
        if (!pythonJob || pythonJob.finishedAt) {
          sendJson(response, 409, { ok: false, error: 'no-active-job' });
          return;
        }
        const body = await readJsonBody(request);
        const action = String(body.action ?? '');
        if (action !== 'cancel' && action !== 'pause') {
          sendJson(response, 400, { ok: false, error: 'unsupported-action' });
          return;
        }
        pythonJob.paused = action === 'pause';
        pythonJob.runner.abort(action === 'pause' ? 'pause' : 'cancelled');
        sendJson(response, 200, { ok: true });
      } catch (error) {
        sendJson(response, 400, { ok: false, error: error?.message ?? String(error) });
      }
    },
  };
  const statusRoute = {
    method: 'GET',
    path: '/api/dsh-plugin-rea/status',
    async handler(request, response) {
      try {
        sendJson(response, 200, await buildStatus(config));
      } catch (error) {
        sendJson(response, 500, { ok: false, error: error?.message ?? String(error) });
      }
    },
  };

  /**
   * Service health. Cheap enough to poll every few seconds: it reuses the same
   * probe as `/status` and reads counters from memory.
   */
  const healthRoute = {
    method: 'GET',
    path: '/api/dsh-plugin-rea/health',
    async handler(request, response) {
      try {
        sendJson(response, 200, await buildHealth({
          tools: toolsRef,
          telemetry,
          python: await probePythonCached(config?.pythonPath),
        }));
      } catch (error) {
        sendJson(response, 500, { ok: false, error: error?.message ?? String(error) });
      }
    },
  };

  /** Telemetry aggregate: totals, slowest tools, failing tools, error groups. */
  const metricsRoute = {
    method: 'GET',
    path: '/api/dsh-plugin-rea/metrics',
    async handler(request, response) {
      try {
        if (!telemetry) {
          sendJson(response, 503, { ok: false, error: 'telemetry not attached' });
          return;
        }
        const url = new URL(request.url, 'http://localhost');
        const limit = Number(url.searchParams.get('limit') ?? 200);
        sendJson(response, 200, { ok: true, ...telemetry.snapshot({ entryLimit: Number.isFinite(limit) ? limit : 200 }) });
      } catch (error) {
        sendJson(response, 500, { ok: false, error: error?.message ?? String(error) });
      }
    },
  };

  /**
   * Live tool-call stream.
   *
   * Two modes on one path: plain JSON for a poll (`?since=<seq>`), and Server-Sent
   * Events when the client asks for `?stream=1`. SSE is what makes the panel feel
   * live without a timer, and it costs one long-lived connection instead of a
   * request every few hundred milliseconds.
   */
  const eventsRoute = {
    method: 'GET',
    path: '/api/dsh-plugin-rea/events',
    async handler(request, response) {
      try {
        if (!telemetry) {
          sendJson(response, 503, { ok: false, error: 'telemetry not attached' });
          return;
        }
        const url = new URL(request.url, 'http://localhost');

        if (url.searchParams.get('stream') === '1') {
          response.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store, no-transform',
            connection: 'keep-alive',
            // Prevent a proxy from buffering the stream into uselessness.
            'x-accel-buffering': 'no',
          });
          response.write('retry: 3000\n\n');

          const send = (event) => {
            try {
              response.write(`data: ${JSON.stringify(event)}\n\n`);
            } catch {
              // A closed socket ends the stream on the next tick.
            }
          };

          telemetry.on('entry', send);

          // A comment frame keeps an idle connection alive through proxies that
          // drop silent sockets.
          const keepAlive = setInterval(() => {
            try {
              response.write(': keep-alive\n\n');
            } catch {
              clearInterval(keepAlive);
            }
          }, 15_000);
          if (typeof keepAlive.unref === 'function') keepAlive.unref();

          const cleanup = () => {
            clearInterval(keepAlive);
            telemetry.off('entry', send);
          };
          request.on('close', cleanup);
          request.on('error', cleanup);
          return;
        }

        const since = Number(url.searchParams.get('since') ?? 0);
        const limit = Number(url.searchParams.get('limit') ?? 100);
        const rows = telemetry.since(Number.isFinite(since) ? since : 0);

        sendJson(response, 200, {
          ok: true,
          dropped: telemetry.dropped,
          nextSeq: telemetry.nextSeq,
          entries: rows.slice(0, Number.isFinite(limit) ? limit : 100),
        });
      } catch (error) {
        sendJson(response, 500, { ok: false, error: error?.message ?? String(error) });
      }
    },
  };

  /** Clear telemetry counters so a user can watch one reproduction cleanly. */
  const resetMetricsRoute = {
    method: 'POST',
    path: '/api/dsh-plugin-rea/metrics/reset',
    async handler(request, response) {
      try {
        if (!telemetry) {
          sendJson(response, 503, { ok: false, error: 'telemetry not attached' });
          return;
        }
        const body = await readJsonBody(request);
        telemetry.reset({ clearEntries: body.clearEntries !== false });
        sendJson(response, 200, { ok: true });
      } catch (error) {
        sendJson(response, 400, { ok: false, error: error?.message ?? String(error) });
      }
    },
  };

  const installRoute = {
    method: 'POST',
    path: '/api/dsh-plugin-rea/install',
    async handler(request, response) {
      try {
        const body = await readJsonBody(request);
        const only = Array.isArray(body.only) && body.only.length > 0 ? body.only : undefined;
        const started = startJob(only, config);

        if (started.error) {
          sendJson(response, 409, { ok: false, ...started });
          return;
        }
        sendJson(response, 202, { ok: true, jobId: started.jobId });
      } catch (error) {
        sendJson(response, 400, { ok: false, error: error?.message ?? String(error) });
      }
    },
  };

  const jobRoute = {
    method: 'GET',
    path: '/api/dsh-plugin-rea/job',
    async handler(request, response) {
      try {
        const url = new URL(request.url, 'http://localhost');
        const id = url.searchParams.get('id');
        const job = id ? jobs.get(id) : null;
        if (!job) {
          sendJson(response, 404, { ok: false, error: 'job not found' });
          return;
        }
        sendJson(response, 200, {
          ok: true,
          id: job.id,
          phase: job.phase,
          paused: job.paused,
          finished: job.finishedAt !== null,
          resumable: job.paused === true,
          elapsedMs: (job.finishedAt ?? Date.now()) - job.startedAt,
          engines: job.engines,
          outcomes: job.outcomes,
          environment: job.environment ?? null,
          error: job.error,
        });
      } catch (error) {
        sendJson(response, 400, { ok: false, error: error?.message ?? String(error) });
      }
    },
  };

  /** Pause / resume one job without losing downloaded bytes. */
  const controlRoute = {
    method: 'POST',
    path: '/api/dsh-plugin-rea/control',
    async handler(request, response) {
      try {
        const body = await readJsonBody(request);
        if (!body.id) {
          sendJson(response, 400, { ok: false, error: 'id is required' });
          return;
        }
        const result = controlJob(body.id, body.action);
        if (result.error) {
          const status = result.error === 'job-not-found' ? 404 : 409;
          sendJson(response, status, { ok: false, ...result });
          return;
        }
        sendJson(response, 200, result);
      } catch (error) {
        sendJson(response, 400, { ok: false, error: error?.message ?? String(error) });
      }
    },
  };

  const cancelRoute = {
    method: 'POST',
    path: '/api/dsh-plugin-rea/cancel',
    async handler(request, response) {
      try {
        const body = await readJsonBody(request);
        const job = body.id ? jobs.get(body.id) : null;
        if (!job) {
          sendJson(response, 404, { ok: false, error: 'job not found' });
          return;
        }
        // Cancelling is a deliberate stop, not a pause: the partial files stay
        // on disk so a later install resumes, but this job is not resumable.
        job.paused = false;
        job.controller?.abort();
        sendJson(response, 200, { ok: true });
      } catch (error) {
        sendJson(response, 400, { ok: false, error: error?.message ?? String(error) });
      }
    },
  };

  /** Report what an uninstall would remove, before anything is deleted. */
  const uninstallPreviewRoute = {
    method: 'GET',
    path: '/api/dsh-plugin-rea/uninstall-preview',
    async handler(request, response) {
      try {
        const url = new URL(request.url, 'http://localhost');
        const only = url.searchParams.getAll('id');
        sendJson(response, 200, await inspectUninstall(only.length > 0 ? only : undefined));
      } catch (error) {
        sendJson(response, 500, { ok: false, error: error?.message ?? String(error) });
      }
    },
  };

  /** Remove plugin-managed engine directories. */
  const uninstallRoute = {
    method: 'POST',
    path: '/api/dsh-plugin-rea/uninstall',
    async handler(request, response) {
      try {
        const body = await readJsonBody(request);
        const only = Array.isArray(body.only) && body.only.length > 0 ? body.only : undefined;

        // Refuse while an install runs: deleting a directory the installer is
        // writing into would produce a corrupt engine with no clear error.
        const running = [...jobs.values()].find((job) => !job.finishedAt && !job.paused);
        if (running) {
          sendJson(response, 409, {
            ok: false,
            error: 'job-running',
            detail: '有安装任务正在进行，请先暂停或等待完成',
          });
          return;
        }

        const result = await uninstallEngines({ only });
        sendJson(response, 200, {
          ok: result.outcomes.every((outcome) => outcome.status !== 'failed' && outcome.status !== 'refused'),
          outcomes: result.outcomes,
          environment: result.environment,
          restartRequired: result.outcomes.some((outcome) => outcome.status === 'removed'),
        });
      } catch (error) {
        sendJson(response, 400, { ok: false, error: error?.message ?? String(error) });
      }
    },
  };

  const allRoutes = [
    updateRoute,
    jdkStatusRoute,
    jdkInstallRoute,
    jdkUninstallRoute,
    pythonPreviewRoute,
    pythonInstallRoute,
    pythonJobRoute,
    pythonControlRoute,
    statusRoute,
    mcpStartRoute,
    healthRoute,
    metricsRoute,
    eventsRoute,
    resetMetricsRoute,
    installRoute,
    jobRoute,
    controlRoute,
    cancelRoute,
    uninstallPreviewRoute,
    uninstallRoute,
  ];

  return {
    routes: allRoutes,
    /**
     * Called by the plugin once `webServer` is available. `telemetry` and
     * `tools` are optional: without them the monitoring routes report 503, and
     * install/uninstall keep working, so a partial composition still functions.
     */
    attach(webServer, { telemetry: telemetryService = null, tools = null } = {}) {
      telemetry = telemetryService;
      toolsRef = tools;
      for (const route of allRoutes) disposers.push(webServer.register(route));
    },
    dispose() {
      for (const job of jobs.values()) job.controller?.abort();
      jobs.clear();
      for (const dispose of disposers.splice(0)) {
        try {
          dispose();
        } catch {
          // A failed unregister must not block the remaining ones.
        }
      }
    },
  };
}

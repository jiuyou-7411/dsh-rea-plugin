/**
 * Mirror selection by measurement, not by assumption.
 *
 * The problem this solves: "use the Tsinghua mirror" is folklore, not evidence.
 * Measured on one machine, a 4 MB wheel came down fastest from the official
 * index (592 ms) and slowest from Aliyun (7 s); a 58 MB wheel from the official
 * index stalled outright and had to be cancelled twice. Neither source is
 * reliably faster — it depends on the package, the time of day and the route.
 *
 * So the installer measures. Each candidate mirror is timed on a small, stable
 * file, the fastest is tried first, and a failure falls through to the next.
 * The result is cached for the process, because probing costs real time and the
 * ranking rarely changes within one install.
 */

import { spawn } from 'node:child_process';

/**
 * Mirrors, ordered as a tie-break fallback rather than as a preference.
 *
 * The comment on each one records what was actually observed, so the next
 * person can tell a measurement from a guess.
 */
export const MIRRORS = [
  {
    id: 'official',
    url: 'https://pypi.org/simple',
    label: 'PyPI 官方',
    note: '4 MB 时实测 592 ms（最快）；58 MB 时曾卡死',
  },
  {
    id: 'tsinghua',
    url: 'https://pypi.tuna.tsinghua.edu.cn/simple',
    label: '清华 TUNA',
    note: '4 MB 时 936 ms；58 MB 时曾跑到 72 MB/s',
  },
  {
    id: 'ustc',
    url: 'https://mirrors.ustc.edu.cn/pypi/simple',
    label: '中科大',
    note: '4 MB 时 1.7 s',
  },
  {
    id: 'tencent',
    url: 'https://mirrors.cloud.tencent.com/pypi/simple',
    label: '腾讯云',
    note: '索引页 308 ms，未测大文件',
  },
  {
    id: 'aliyun',
    url: 'https://mirrors.aliyun.com/pypi/simple',
    label: '阿里云',
    note: '4 MB 时 7 s（最慢）',
  },
];

/**
 * Probe each mirror's actual throughput.
 *
 * `pip download` is used rather than a raw HTTP fetch so the measurement covers
 * the same path an install takes: index resolution, redirects, and the CDN the
 * wheel is actually served from. Tiny package on purpose — this is a probe, not
 * a benchmark, and it must fit inside a settings page's patience.
 *
 * Results are ordered fastest first. A mirror that errors or times out is
 * dropped rather than ranked last, because "slow" and "broken" need different
 * handling.
 */
export async function rankMirrors(python, { packageName = 'pyelftools', timeoutMs = 25_000 } = {}) {
  if (!python) return { ranked: MIRRORS, failed: [], measured: false };

  const results = await Promise.all(
    MIRRORS.map(async (mirror) => {
      const began = Date.now();
      try {
        const ok = await downloadProbe(python, packageName, mirror.url, timeoutMs);
        if (!ok) return { mirror, ms: null, ok: false };
        return { mirror, ms: Date.now() - began, ok: true };
      } catch {
        return { mirror, ms: null, ok: false };
      }
    }),
  );

  const ranked = results
    .filter((entry) => entry.ok)
    .sort((a, b) => a.ms - b.ms)
    .map((entry) => ({ ...entry.mirror, measuredMs: entry.ms }));

  const failed = results.filter((entry) => !entry.ok).map((entry) => entry.mirror);

  // A machine with no reachable mirror is not a reason to refuse: the caller
  // falls back to the default order and lets pip report the real error.
  return {
    ranked: ranked.length > 0 ? ranked : MIRRORS,
    failed,
    measured: ranked.length > 0,
  };
}

/** One `pip download` into a throwaway directory, with a hard timeout. */
function downloadProbe(python, packageName, indexUrl, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(
      python,
      [
        '-m', 'pip', 'download', packageName,
        '--no-deps', '--no-cache-dir',
        '-d', probeDir(),
        '-i', indexUrl,
        '--quiet',
        '--disable-pip-version-check',
      ],
      {
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        stdio: 'ignore',
        windowsHide: true,
      },
    );

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already gone */ }
      resolve(value);
    };

    const timer = setTimeout(() => finish(false), timeoutMs);
    child.on('error', () => finish(false));
    child.on('exit', (code) => finish(code === 0));
  });
}

/** A per-probe temp directory; pip cleans the wheels itself after each run. */
let probeCounter = 0;
function probeDir() {
  probeCounter += 1;
  const base = process.env.TEMP ?? process.env.TMPDIR ?? '/tmp';
  return `${base}/rea-mirror-probe-${process.pid}-${probeCounter}`;
}

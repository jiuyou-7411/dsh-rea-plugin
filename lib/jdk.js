/**
 * JDK provisioning.
 *
 * Ghidra 11.2+ requires Java 21, and the machine may have 17 (or nothing). Java
 * is a different install problem from the analysis engines:
 *
 *  - It ships as an `.msi`/`.pkg`/`.tar.gz`, not a zip we can unpack into
 *    `~/.dsh/rea-engines`, and on Windows the MSI wants administrator rights.
 *  - The system already has a Java that other tools use. Replacing `JAVA_HOME`
 *    globally would change every other program on the machine, which is not
 *    something a plugin should do without being asked.
 *
 * So this installs a *private* JDK into the plugin's own cache and exposes it
 * through `REA_JAVA_HOME`. Ghidra reads that first; everything else keeps the
 * system Java. Nothing global changes.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

/** Where a private JDK lives. Sibling of the engine cache, so one delete cleans both. */
export const JDK_ROOT = path.join(os.homedir(), '.dsh', 'rea-jdk');

/** The major version Ghidra 11.x requires. */
export const REQUIRED_JAVA = 21;

/**
 * Download sources, tried in order until one is fast enough to finish.
 *
 * Measured on a Chinese network: `api.adoptium.net` served the 196 MB Windows
 * archive at 0.04 MB/s — 85 minutes, and long enough that the 60 s stall timer
 * aborted it every time. The Tsinghua mirror of the same Adoptium tree delivered
 * 1.9 MB/s, about 47× faster. So the mirror comes first and the official API is
 * the fallback for networks where the mirror is unreachable.
 *
 * The mirror path is resolved by reading its directory index rather than
 * hardcoding a build number: OpenJDK 21 receives updates, and a pinned filename
 * would 404 after the next one.
 */
const TUNA_ADOPTIUM = 'https://mirrors.tuna.tsinghua.edu.cn/Adoptium';

function platformSegments() {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';

  if (process.platform === 'win32') {
    return {
      adoptium: { os: 'windows', arch, kind: 'zip' },
      tuna: { os: 'windows', arch, kind: 'zip', pattern: /OpenJDK21U-jdk_x64_windows_hotspot.*\.zip$/ },
      archive: 'jdk.zip',
    };
  }
  if (process.platform === 'darwin') {
    return {
      adoptium: { os: 'mac', arch, kind: 'tar.gz' },
      tuna: { os: 'mac', arch, kind: 'tar.gz', pattern: /OpenJDK21U-jdk_aarch64_mac_hotspot.*\.tar\.gz$/ },
      archive: 'jdk.tar.gz',
    };
  }
  return {
    adoptium: { os: 'linux', arch, kind: 'tar.gz' },
    tuna: { os: 'linux', arch, kind: 'tar.gz', pattern: /OpenJDK21U-jdk_x64_linux_hotspot.*\.tar\.gz$/ },
    archive: 'jdk.tar.gz',
  };
}

/** Absolute mirror URL for the newest matching build, or null if unreachable. */
async function resolveMirrorUrl(spec) {
  const directory = `${TUNA_ADOPTIUM}/${REQUIRED_JAVA}/jdk/${spec.arch}/${spec.os}/`;
  try {
    const response = await fetch(`${directory}?mirrorlist`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;

    const html = await response.text();
    const names = [...html.matchAll(/href="([^"]+)"/g)]
      .map((match) => match[1])
      .filter((href) => spec.pattern.test(href));

    if (names.length === 0) return null;
    // Directory listings sort lexicographically; the last match is the newest.
    return directory + names[names.length - 1];
  } catch {
    return null;
  }
}

/**
 * Candidate list for this platform, best first.
 *
 * Resolved lazily so an unreachable mirror costs one HEAD and not a failed
 * install.
 */
async function downloadCandidates() {
  const segments = platformSegments();
  const candidates = [];

  const mirror = await resolveMirrorUrl(segments.tuna);
  if (mirror) {
    candidates.push({ url: mirror, label: '清华镜像', kind: segments.tuna.kind });
  }

  candidates.push({
    url: `https://api.adoptium.net/v3/binary/latest/${REQUIRED_JAVA}/ga`
      + `/${segments.adoptium.os}/${segments.adoptium.arch}/jdk/hotspot/normal/eclipse`,
    label: 'Adoptium 官方',
    kind: segments.adoptium.kind,
  });

  return { candidates, archive: segments.archive };
}

/** Run a binary and capture its first stderr/stdout line. */
function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('error', () => resolve({ ok: false, text: '' }));
    child.on('exit', (code) => resolve({ ok: code === 0, text: out }));
  });
}

/** Parse the major version out of `java -version` output. */
export function parseJavaMajor(text) {
  // Java 8 prints `1.8.0_xxx`; 9+ prints `21.0.1` or `21`.
  const quoted = /version "(\d+)(?:\.(\d+))?/.exec(text ?? '');
  if (quoted) {
    const major = Number(quoted[1]);
    return major === 1 ? Number(quoted[2] ?? 0) : major;
  }
  const bare = /(?:openjdk|java)\s+(\d+)/i.exec(text ?? '');
  return bare ? Number(bare[1]) : null;
}

/**
 * Find a JDK 21+ without downloading anything.
 *
 * Order: the private cache (our own install), then `REA_JAVA_HOME`, then
 * `JAVA_HOME`, then PATH. The private cache wins so a plugin install is stable
 * regardless of what the user later changes globally.
 */
export async function findJdk21() {
  const candidates = [];

  // 1. our own install
  if (existsSync(JDK_ROOT)) {
    const entries = await fs.readdir(JDK_ROOT).catch(() => []);
    for (const entry of entries) {
      const home = path.join(JDK_ROOT, entry);
      candidates.push({
        home,
        java: path.join(home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'),
        source: 'plugin',
      });
    }
  }

  // 2. operator-provided
  for (const [envName, source] of [['REA_JAVA_HOME', 'rea-java-home'], ['JAVA_HOME', 'java-home']]) {
    const home = process.env[envName];
    if (!home) continue;
    candidates.push({
      home,
      java: path.join(home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'),
      source,
    });
  }

  // 3. PATH
  candidates.push({
    home: null,
    java: 'java',
    source: 'path',
  });

  for (const candidate of candidates) {
    if (candidate.home && !existsSync(candidate.java)) continue;

    const result = await run(candidate.java, ['-version']);
    if (!result.ok || !result.text) continue;

    const major = parseJavaMajor(result.text);
    if (major === null) continue;

    return {
      present: major >= REQUIRED_JAVA,
      major,
      sufficient: major >= REQUIRED_JAVA,
      home: candidate.home,
      java: candidate.java,
      source: candidate.source,
      version: result.text.split('\n')[0].trim(),
      required: REQUIRED_JAVA,
    };
  }

  return {
    present: false,
    major: null,
    sufficient: false,
    home: null,
    java: null,
    source: null,
    version: null,
    required: REQUIRED_JAVA,
  };
}

/**
 * Download and unpack a private JDK 21.
 *
 * `onProgress` gets byte counts so the panel can show a bar; the archive is
 * ~180 MB and takes long enough that silence would look like a hang.
 */
export async function installJdk({ onProgress, signal } = {}) {
  const { candidates, archive } = await downloadCandidates();
  await fs.mkdir(JDK_ROOT, { recursive: true });

  const archivePath = path.join(JDK_ROOT, archive);

  // Download with Range support so a resumed job continues rather than restarting.
  const { download } = await import('./providers.js');

  let downloaded = null;
  const failures = [];

  for (const candidate of candidates) {
    if (signal?.aborted) throw new Error('已取消');
    onProgress?.({
      phase: 'download',
      percent: 0,
      received: 0,
      total: 0,
      source: candidate.label,
    });

    try {
      await download(candidate.url, archivePath, {
        maxBytes: 512 * 1024 * 1024,
        signal,
        // A 196 MB archive on a slow link needs more patience than the 60 s
        // default: the mirror moves 1.9 MB/s but can pause longer than that on
        // a congested link without the transfer being dead.
        stallMs: 180_000,
        onProgress: (progress) => onProgress?.({
          phase: 'download',
          received: progress.received,
          total: progress.total,
          percent: progress.percent,
          bytesPerSecond: progress.bytesPerSecond,
          source: candidate.label,
        }),
      });
      downloaded = candidate;
      break;
    } catch (error) {
      // A cancelled job is not a source failure; do not try the next URL.
      if (signal?.aborted) throw error;
      failures.push(`${candidate.label}: ${error?.message ?? error}`);
      onProgress?.({
        phase: 'download',
        percent: 0,
        received: 0,
        total: 0,
        source: `${candidate.label} 失败，换下一个源`,
      });
    }
  }

  if (!downloaded) {
    throw new Error(`所有下载源均失败：\n${failures.join('\n')}`);
  }

  onProgress?.({ phase: 'extract', percent: 100 });

  // Unpack into a staging directory, then move the single top-level folder in.
  const staging = path.join(JDK_ROOT, '.staging');
  await fs.rm(staging, { recursive: true, force: true });
  await fs.mkdir(staging, { recursive: true });

  await extractArchive(archivePath, staging, downloaded.kind, { signal });

  const entries = await fs.readdir(staging);
  const root = entries.length === 1 ? path.join(staging, entries[0]) : staging;

  // Give it a stable name so `findJdk21` cannot accumulate a second copy.
  const target = path.join(JDK_ROOT, `jdk-${REQUIRED_JAVA}`);
  await fs.rm(target, { recursive: true, force: true });
  await fs.rename(root, target);

  await fs.rm(staging, { recursive: true, force: true });
  await fs.rm(archivePath, { force: true });

  onProgress?.({ phase: 'done', percent: 100 });

  return { home: target, java: path.join(target, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') };
}

/**
 * Extract a zip or tar.gz using the platform's own tools.
 *
 * Deliberately not a JS archiver: a JDK archive is ~300 MB unpacked with tens
 * of thousands of entries, and the OS tools are both faster and guaranteed to
 * preserve the executable bits on Unix.
 */
function extractArchive(archive, destination, kind, { signal } = {}) {
  return new Promise((resolve, reject) => {
    let command;
    let args;

    if (kind === 'zip') {
      if (process.platform === 'win32') {
        command = 'powershell.exe';
        args = ['-NoProfile', '-NonInteractive', '-Command',
          `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${destination.replace(/'/g, "''")}' -Force`];
      } else {
        command = 'unzip';
        args = ['-q', archive, '-d', destination];
      }
    } else {
      command = 'tar';
      args = ['-xzf', archive, '-C', destination];
    }

    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => { stderr += c; });

    const onAbort = () => {
      try { child.kill(); } catch { /* already gone */ }
      reject(new Error('解压已取消'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (error) => {
      signal?.removeEventListener('abort', onAbort);
      reject(new Error(`解压失败：${error.message}`));
    });
    child.on('exit', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (code === 0) resolve();
      else reject(new Error(`解压失败（退出码 ${code}）${stderr ? `：${stderr.slice(-400)}` : ''}`));
    });
  });
}

/** Remove the private JDK and report what it freed. */
export async function uninstallJdk() {
  if (!existsSync(JDK_ROOT)) return { removed: false, freedBytes: 0 };

  let freedBytes = 0;
  const walk = async (dir) => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else {
        const stat = await fs.stat(full).catch(() => null);
        if (stat) freedBytes += stat.size;
      }
    }
  };
  await walk(JDK_ROOT);

  await fs.rm(JDK_ROOT, { recursive: true, force: true });
  return { removed: true, freedBytes };
}

/** Size of the private JDK on disk, for the uninstall preview. */
export async function jdkDirectorySize() {
  if (!existsSync(JDK_ROOT)) return 0;
  let total = 0;
  const walk = async (dir) => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else {
        const stat = await fs.stat(full).catch(() => null);
        if (stat) total += stat.size;
      }
    }
  };
  await walk(JDK_ROOT);
  return total;
}

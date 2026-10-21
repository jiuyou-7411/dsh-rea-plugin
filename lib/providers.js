/**
 * Analysis-engine bootstrap for the REA bundle.
 *
 * One user action — pressing Install — does everything: resolve the release,
 * download with resume, extract, verify, and report the environment variables
 * REA needs. Nothing is bundled: engines land in a per-user directory at
 * `~/.dsh/rea-engines/<engine>/`, which survives plugin reinstalls and can be
 * deleted to reclaim disk.
 *
 * Three constraints shaped the implementation:
 *
 *  - **Progress is observable.** A 543 MiB Ghidra download is minutes long, so
 *    bytes received, phase, and percent are pushed to listeners rather than
 *    inferred from a spinner.
 *  - **Resumable.** A partial file survives interruption and the next attempt
 *    continues from that offset. Switching mirrors mid-transfer would corrupt a
 *    prefix, so the downloader refuses to do that.
 *  - **Verification, not exit codes.** An engine counts as ready only when a
 *    probe finds its launcher and, for JADX, an archive containing REA's exact
 *    bridge classes. A download that "succeeded" but cannot be used is a
 *    failure.
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { accessSync, readdirSync, existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * A transfer stopped by the caller (pause or cancel), as opposed to one that
 * failed on its own.
 *
 * The distinction matters at every layer above: the downloader keeps the partial
 * file, the installer records `cancelled` rather than `failed`, and the job
 * reports `paused` rather than `error`. A plain Error would collapse all three
 * into "something broke".
 */
class DownloadAborted extends Error {
  constructor(detail = '传输已暂停') {
    super(detail);
    this.name = 'DownloadAborted';
    this.aborted = true;
  }
}

/** Version pin shared with cordis.patch.yml. */
export const REA_AGENTS_VERSION = '6.7.0';

/** Where engines are installed. Survives plugin reinstalls. */
export const CACHE_ROOT = path.join(os.homedir(), '.dsh', 'rea-engines');

/**
 * Download sources in preference order.
 *
 * Upstream GitHub is tried first because it is authoritative. Public mirrors
 * follow, because on some networks the release CDN accepts a connection and then
 * sends nothing — measured at a 24-second hard failure versus 1.2-1.8 second
 * mirror responses. A mirror relays bytes already published upstream, so the
 * source of truth does not change.
 *
 * `REA_DOWNLOAD_MIRRORS` prepends caller entries as `<prefix>=<base-url>`;
 * `REA_DOWNLOAD_MIRRORS=off` disables every mirror.
 */
const DEFAULT_GITHUB_MIRRORS = [
  'https://ghfast.top/https://github.com',
  'https://gh-proxy.com/https://github.com',
  'https://ghproxy.net/https://github.com',
];

function candidateUrls(url) {
  const override = process.env.REA_DOWNLOAD_MIRRORS ?? '';
  if (override.trim().toLowerCase() === 'off') return [url];

  const callerRules = override
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const index = entry.indexOf('=');
      return index > 0 ? { prefix: entry.slice(0, index), base: entry.slice(index + 1) } : null;
    })
    .filter(Boolean);

  const builtIn = DEFAULT_GITHUB_MIRRORS.map((base) => ({ prefix: 'https://github.com', base }));
  const candidates = [];

  for (const rule of [...callerRules, ...builtIn]) {
    if (url.includes(rule.prefix)) candidates.push(url.replace(rule.prefix, rule.base));
  }
  candidates.push(url);

  const seen = new Set();
  return candidates.filter((candidate) => {
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    return true;
  });
}

async function run(command, args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: options.timeoutMs ?? 60_000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return { ok: true, stdout: stdout ?? '', stderr: stderr ?? '' };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
      code: error.code ?? null,
      message: error.message,
    };
  }
}

/**
 * Run a shell script (.cmd / .bat). `shell: true` lets the platform quote the
 * path, which is the only portable way to run a batch file whose path contains
 * spaces such as `C:\Program Files\...`.
 */
async function runShell(command, args, options = {}) {
  const quoted = command.includes(' ') ? `"${command}"` : command;
  const line = [quoted, ...args].join(' ');
  try {
    const { stdout, stderr } = await execFileAsync(line, [], {
      shell: true,
      timeout: options.timeoutMs ?? 300_000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return { ok: true, stdout: stdout ?? '', stderr: stderr ?? '' };
  } catch (error) {
    return { ok: false, stdout: error.stdout ?? '', stderr: error.stderr ?? '', message: error.message };
  }
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(target) {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

function firstLine(text) {
  return String(text).split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
}

/**
 * Resolve an executable to a runnable absolute path.
 *
 * A GUI-launched Host has no login shell PATH, so bare `which npm` is
 * unreliable. On Windows the runnable sibling of an extensionless `where` hit is
 * the `.cmd`, which is probed beside the running node binary first.
 */
async function which(command) {
  if (process.platform === 'win32') {
    const nodeDirectory = path.dirname(process.execPath);
    for (const name of [`${command}.cmd`, `${command}.bat`, `${command}.exe`]) {
      const candidate = path.join(nodeDirectory, name);
      if (await exists(candidate)) return candidate;
    }
    const probe = await run('where', [command]);
    if (probe.ok) {
      const lines = String(probe.stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const runnable = lines.find((line) => /\.(cmd|bat|exe)$/i.test(line));
      if (runnable) return runnable;
      if (lines.length > 0) return `${lines[0]}.cmd`;
    }
    return null;
  }
  const probe = await run('which', [command]);
  if (!probe.ok) return null;
  return String(probe.stdout).split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
}

async function findFile(root, predicate, { maxDepth = 6 } = {}) {
  const queue = [{ directory: root, depth: 0 }];
  while (queue.length > 0) {
    const { directory, depth } = queue.shift();
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isFile() && predicate(entry.name, full)) return full;
      if (entry.isDirectory() && depth < maxDepth) queue.push({ directory: full, depth: depth + 1 });
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Download with progress, resume and mirror fallback
// ---------------------------------------------------------------------------

/**
 * Move a finished download into place, surviving Windows handle lag.
 *
 * `fs.rename` is atomic and instant on POSIX, but on Windows it fails with
 * `EPERM` while any handle to either path is still open — and an antivirus
 * scanner or a just-closed stream can hold one for a few hundred milliseconds
 * after the bytes are on disk. Retrying briefly covers the common case; copying
 * and deleting covers a lock that outlives the retries, at the cost of one extra
 * pass over the file.
 */
async function renameWithRetry(from, to, attempts = 6) {
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      lastError = error;
      // ENOENT means someone else moved it; nothing to retry.
      if (error?.code === 'ENOENT') throw error;
      await new Promise((resolve) => setTimeout(resolve, 120 * (attempt + 1)));
    }
  }

  // A lock that survives ~2.5 s of retries: copy instead, then drop the source.
  try {
    await fs.copyFile(from, to);
    await fs.rm(from, { force: true });
    return;
  } catch {
    throw lastError;
  }
}

/**
 * Download one URL to a file.
 *
 * @param onProgress called with `{ received, total, percent, bytesPerSecond }`
 *                   whenever enough bytes have arrived to be worth a repaint.
 */
export async function download(url, destination, { maxBytes, signal, onProgress, stallMs = 60_000 } = {}) {
  const temporary = `${destination}.partial`;
  await fs.mkdir(path.dirname(destination), { recursive: true });

  // A caller that aborted before the transfer starts must not open a socket,
  // and must surface the abort rather than reporting an empty download.
  if (signal?.aborted) {
    throw new DownloadAborted();
  }

  // Resume from a previous interruption.
  let resumeFrom = 0;
  try {
    resumeFrom = (await fs.stat(temporary)).size;
  } catch {
    resumeFrom = 0;
  }

  const controller = new AbortController();
  let abortedByCaller = false;
  const abort = () => {
    abortedByCaller = true;
    controller.abort();
  };
  signal?.addEventListener('abort', abort, { once: true });

  /**
   * Set only when the stall timer is what aborted the transfer, so the catch
   * block can tell a dead connection from a deliberate cancel.
   */
  let stalled = false;

  // A stall timer reset on every chunk: a slow-but-progressing transfer
  // survives, a genuinely stuck one fails in a minute.
  let stallTimer;
  const armStall = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, stallMs);
  };

  const startedAt = Date.now();
  const startBytes = resumeFrom;

  try {
    armStall();
    const headers = resumeFrom > 0 ? { range: `bytes=${resumeFrom}-` } : {};
    const response = await fetch(url, { redirect: 'follow', signal: controller.signal, headers });

    if (response.status === 416) {
      await renameWithRetry(temporary, destination);
      return { bytes: resumeFrom, resumed: true, note: 'partial file already complete' };
    }
    if (!response.ok && response.status !== 206) {
      throw new Error(`HTTP ${response.status}`);
    }

    // A server that ignores Range returns the whole body, so the partial prefix
    // must be discarded rather than appended.
    const appending = response.status === 206 && resumeFrom > 0;
    if (!appending) resumeFrom = 0;

    const declared = Number(response.headers.get('content-length') ?? 0);
    const total = appending && declared ? resumeFrom + declared : declared;
    if (maxBytes && total > maxBytes) {
      throw new Error(`download is ${Math.round(total / 1048576)} MiB, over the ${Math.round(maxBytes / 1048576)} MiB cap`);
    }

    const handle = await fs.open(temporary, appending ? 'a' : 'w');
    const hash = createHash('sha256');
    let received = resumeFrom;
    let lastReport = 0;

    try {
      const reader = response.body.getReader();
      for (;;) {
        armStall();
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (maxBytes && received > maxBytes) {
          throw new Error(`download exceeded the ${Math.round(maxBytes / 1048576)} MiB cap at ${received} bytes`);
        }
        hash.update(value);
        await handle.write(value);

        // Throttle to ~4 reports/second: enough for a smooth bar, far below the
        // chunk rate of a fast connection.
        const now = Date.now();
        if (onProgress && (now - lastReport > 250 || received === total)) {
          lastReport = now;
          const elapsed = Math.max(1, (now - startedAt) / 1000);
          onProgress({
            received,
            total: total || null,
            percent: total ? Math.min(100, (received / total) * 100) : null,
            bytesPerSecond: (received - startBytes) / elapsed,
          });
        }
      }
    } finally {
      await handle.close();
      clearTimeout(stallTimer);
    }

    if (received === 0) {
      await fs.rm(temporary, { force: true });
      throw new Error('download produced 0 bytes');
    }
    if (total && received < total) {
      // Keep the partial file so a re-run resumes instead of restarting.
      throw new Error(`truncated at ${received} of ${total} bytes; re-run to resume`);
    }

    // Windows refuses a rename while any handle to either path is open, and a
    // finished fetch body can keep one until it is cancelled. Releasing it here
    // is what stops a perfectly complete download from failing with
    // `EPERM: operation not permitted, rename`.
    await renameWithRetry(temporary, destination);
    return { bytes: received, resumed: appending, sha256: appending ? null : hash.digest('hex') };
  } catch (error) {
    // Three different things arrive here as AbortError, and conflating them was
    // a real bug: a stall timeout surfaced as "This operation was aborted",
    // which reads as the user cancelling and names no cause at all.
    //
    //   caller     -> DownloadAborted, partial file kept as the resume point
    //   stall      -> a named timeout naming the stall, partial file kept
    //   otherwise  -> the real error, unchanged
    if (abortedByCaller || (error?.name === 'AbortError' && signal?.aborted)) {
      throw new DownloadAborted();
    }
    if (stalled) {
      throw new Error(
        `下载中断：${Math.round(stallMs / 1000)} 秒没有收到数据`
        + `（已收 ${Math.round(startBytes / 1048576)} MB）。`
        + '已保留部分文件，重试会从断点继续。',
      );
    }
    throw error;
  } finally {
    clearTimeout(stallTimer);
    signal?.removeEventListener('abort', abort);
  }
}

/**
 * Try every candidate URL in order.
 *
 * A truncated transfer stops the loop: its partial file is the resume point, and
 * continuing against a different mirror would append a different source's bytes
 * onto that prefix.
 */
async function downloadFirst(url, destination, options = {}) {
  const attempts = [];
  for (const candidate of candidateUrls(url)) {
    try {
      const result = await download(candidate, destination, options);
      return { ...result, url: candidate, attempts };
    } catch (error) {
      // A pause or cancel must stop the whole chain, not fall through to the
      // next mirror: retrying at a different URL would resume a different
      // source's bytes onto the same partial prefix.
      if (error?.aborted || options.signal?.aborted) throw error;

      if (/truncated/.test(error.message)) {
        let kept = 0;
        try {
          kept = (await fs.stat(`${destination}.partial`)).size;
        } catch {
          kept = 0;
        }
        throw new Error(
          `${error.message}. ${Math.round(kept / 1048576)} MiB 已保留，重新点击安装会从断点继续。`,
        );
      }
      attempts.push({ url: candidate, error: error.message });
    }
  }
  throw new Error(
    `所有下载源都失败：${attempts.map((attempt) => `${attempt.url} → ${attempt.error}`).join('；')}。`
    + ' 可设置 REA_DOWNLOAD_MIRRORS 指向可达镜像。',
  );
}

/**
 * Extract an archive using a tool that ships with the OS. Windows 10+ has
 * bsdtar (which reads zip), with PowerShell Expand-Archive as a fallback for
 * archives bsdtar has choked on.
 */
async function extractArchive(archive, destination, { signal, onProgress } = {}) {
  await fs.mkdir(destination, { recursive: true });
  const lower = archive.toLowerCase();
  onProgress?.({ phase: 'extract' });

  if (process.platform === 'win32') {
    const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    const useTar = (await exists(tar)) ? tar : 'tar';
    const viaTar = await run(useTar, ['-xf', archive, '-C', destination], { signal, timeoutMs: 1_800_000 });
    if (viaTar.ok) return;

    if (lower.endsWith('.zip')) {
      const viaPowerShell = await run('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${destination.replace(/'/g, "''")}' -Force`,
      ], { signal, timeoutMs: 1_800_000 });
      if (viaPowerShell.ok) return;
      throw new Error(
        `解压失败：tar (${firstLine(viaTar.stderr || viaTar.message)}) / `
        + `Expand-Archive (${firstLine(viaPowerShell.stderr || viaPowerShell.message)})`,
      );
    }
    throw new Error(`解压失败：${firstLine(viaTar.stderr || viaTar.message)}`);
  }

  if (lower.endsWith('.zip')) {
    const result = await run('unzip', ['-q', '-o', archive, '-d', destination], { signal, timeoutMs: 1_800_000 });
    if (!result.ok) throw new Error(`解压失败：${firstLine(result.stderr || result.message)}`);
    return;
  }
  const result = await run('tar', ['-xf', archive, '-C', destination], { signal, timeoutMs: 1_800_000 });
  if (!result.ok) throw new Error(`解压失败：${firstLine(result.stderr || result.message)}`);
}

/**
 * Collapse a single top-level directory from the staging area into the final
 * location, so the layout is `.../ghidra/` rather than a version-named folder
 * that changes with every release.
 */
async function normalizeExtraction(staging, finalDirectory) {
  const entries = await fs.readdir(staging, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory());

  await fs.rm(finalDirectory, { recursive: true, force: true });
  await fs.mkdir(path.dirname(finalDirectory), { recursive: true });

  if (directories.length === 1 && entries.length === 1) {
    await fs.rename(path.join(staging, directories[0].name), finalDirectory);
    await fs.rm(staging, { recursive: true, force: true });
    return finalDirectory;
  }

  await fs.rename(staging, finalDirectory);
  return finalDirectory;
}

// ---------------------------------------------------------------------------
// JAR inspection
// ---------------------------------------------------------------------------

async function jarEntryNames(jarPath) {
  const handle = await fs.open(jarPath, 'r');
  try {
    const { size } = await handle.stat();
    const tailLength = Math.min(size, 65557);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, size - tailLength);

    let eocd = -1;
    for (let index = tail.length - 22; index >= 0; index -= 1) {
      if (tail.readUInt32LE(index) === 0x06054b50) {
        eocd = index;
        break;
      }
    }
    if (eocd < 0) return null;

    const entryCount = tail.readUInt16LE(eocd + 10);
    let cursor = tail.readUInt32LE(eocd + 16);

    const header = Buffer.alloc(46);
    const names = [];
    for (let index = 0; index < entryCount; index += 1) {
      await handle.read(header, 0, 46, cursor);
      if (header.readUInt32LE(0) !== 0x02014b50) break;
      const nameLength = header.readUInt16LE(28);
      const extraLength = header.readUInt16LE(30);
      const commentLength = header.readUInt16LE(32);
      const nameBuffer = Buffer.alloc(nameLength);
      await handle.read(nameBuffer, 0, nameLength, cursor + 46);
      names.push(nameBuffer.toString('utf8'));
      cursor += 46 + nameLength + extraLength + commentLength;
    }
    return names;
  } finally {
    await handle.close();
  }
}

const JADX_BRIDGE_CLASSES = [
  'com/atxx/jhmcp/JadxSession.class',
  'com/atxx/jhmcp/SessionHolder.class',
  'jadx/api/JadxDecompiler.class',
  'com/google/gson/Gson.class',
  'io/modelcontextprotocol/kotlin/sdk/server/Server.class',
];

async function jarHasReaBridgeClasses(jarPath) {
  let names;
  try {
    names = await jarEntryNames(jarPath);
  } catch (error) {
    return { ok: false, reason: `jar 无法读取：${error.message}` };
  }
  if (!names) return { ok: false, reason: '文件不是可读的 JAR' };

  const set = new Set(names);
  const missing = JADX_BRIDGE_CLASSES.filter((name) => !set.has(name));
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `jar 缺少 REA 桥接类（${missing.slice(0, 2).join(', ')}`
        + `${missing.length > 2 ? ` 等 ${missing.length} 个` : ''}），`
        + ' 这是 jadx-ai-mcp 而不是 jadx-headless-mcp 0.7.1',
    };
  }
  return { ok: true };
}

export async function probeJava() {
  const found = await which('java');
  if (!found) return { present: false, remediation: '安装 JDK 17+ 并把 java 放进 PATH' };
  const version = await run(found, ['-version']);
  return { present: true, path: found, version: firstLine(version.stderr || version.stdout) };
}

// ---------------------------------------------------------------------------
// Engine descriptors
// ---------------------------------------------------------------------------

const ghidra = {
  id: 'ghidra',
  title: 'Ghidra',
  directory: 'ghidra',
  envVar: 'GHIDRA_INSTALL_DIR',
  sizeMb: 543,
  pagesUrl: 'https://github.com/NationalSecurityAgency/ghidra/releases',

  async probe() {
    const candidates = [
      process.env.GHIDRA_INSTALL_DIR,
      path.join(CACHE_ROOT, 'ghidra'),
      path.join(os.homedir(), 'ghidra'),
      path.join(os.homedir(), 'tools', 'ghidra'),
      '/opt/ghidra',
      '/usr/local/ghidra',
      '/Applications/ghidra',
    ].filter((candidate) => typeof candidate === 'string' && candidate.length > 0);

    for (const candidate of candidates) {
      if (!(await isDirectory(candidate))) continue;
      const launcher = await findFile(candidate, (name) =>
        name === 'ghidraRun' || name === 'ghidraRun.bat'
        || name === 'analyzeHeadless' || name === 'analyzeHeadless.bat');
      if (!launcher) continue;
      return {
        present: true,
        root: candidate,
        launcher,
        source: candidate === process.env.GHIDRA_INSTALL_DIR ? 'env' : 'discovered',
      };
    }
    return { present: false };
  },

  /** Ghidra ships one `*_PUBLIC*.zip` per release that covers every platform. */
  async resolve({ signal } = {}) {
    const response = await fetch('https://api.github.com/repos/NationalSecurityAgency/ghidra/releases?per_page=30', {
      signal,
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-plugin-rea' },
    });
    if (!response.ok) throw new Error(`GitHub API 返回 HTTP ${response.status}`);

    const releases = await response.json();
    const release = releases.find((candidate) => String(candidate.tag_name ?? '').startsWith('Ghidra_12.1'));
    if (!release) throw new Error('未找到 Ghidra 12.1.x 发布');

    const asset = (release.assets ?? []).find((candidate) => {
      const name = String(candidate.name ?? '').toLowerCase();
      return name.includes('_public') && name.endsWith('.zip');
    });
    if (!asset) throw new Error(`${release.tag_name} 没有 *_PUBLIC*.zip 资源`);

    return { url: asset.browser_download_url, filename: asset.name, version: release.tag_name, sizeBytes: asset.size };
  },

  async install({ asset, signal, maxBytes, onProgress }) {
    const archive = path.join(CACHE_ROOT, '.downloads', asset.filename);
    if (!(await exists(archive))) {
      await downloadFirst(asset.url, archive, {
        maxBytes,
        signal,
        onProgress: (progress) => onProgress?.({ phase: 'download', ...progress }),
      });
    }
    const staging = path.join(CACHE_ROOT, '.staging', 'ghidra');
    await fs.rm(staging, { recursive: true, force: true });
    await extractArchive(archive, staging, { signal, onProgress });
    return normalizeExtraction(staging, path.join(CACHE_ROOT, 'ghidra'));
  },
};

const jadx = {
  id: 'jadx',
  title: 'JADX',
  directory: 'jadx',
  envVar: 'REA_JADX_MCP_JAR',
  sizeMb: 110,
  pagesUrl: 'https://github.com/1013503897/jadx-headless-mcp/releases/tag/v0.7.1',

  async probe() {
    const configured = process.env.REA_JADX_MCP_JAR;
    if (configured && (await exists(configured))) {
      const valid = await jarHasReaBridgeClasses(configured);
      if (valid.ok) return { present: true, root: configured, source: 'env' };
      return { present: false, note: `REA_JADX_MCP_JAR 无效：${valid.reason}` };
    }

    const directory = path.join(CACHE_ROOT, 'jadx');
    const jar = path.join(directory, 'jadx-headless-mcp.jar');
    if (!(await exists(jar))) return { present: false };

    const valid = await jarHasReaBridgeClasses(jar);
    if (!valid.ok) return { present: false, root: jar, note: valid.reason };

    const cli = await jadxCliLauncher(path.join(directory, 'cli'));
    if (!cli) return { present: false, root: jar, note: '缺少 jadx CLI 启动脚本' };
    return { present: true, root: jar, cli, source: 'cache' };
  },

  /**
   * Two assets: the jadx CLI (the decompiler) and the MCP bridge REA requires at
   * exactly 0.7.1. Both are needed; either alone leaves decompilation broken.
   */
  async resolve({ signal } = {}) {
    const headers = { accept: 'application/vnd.github+json', 'user-agent': 'dsh-plugin-rea' };

    const cliResponse = await fetch('https://api.github.com/repos/skylot/jadx/releases/latest', { signal, headers });
    if (!cliResponse.ok) throw new Error(`GitHub API 返回 HTTP ${cliResponse.status}（skylot/jadx）`);
    const cliRelease = await cliResponse.json();
    const cliAsset = (cliRelease.assets ?? []).find((candidate) => /^jadx-[\d.]+\.zip$/.test(String(candidate.name ?? '')));
    if (!cliAsset) throw new Error('jadx 没有 CLI zip 资源');

    const mcpResponse = await fetch(
      'https://api.github.com/repos/1013503897/jadx-headless-mcp/releases/tags/v0.7.1',
      { signal, headers },
    );
    if (!mcpResponse.ok) throw new Error(`GitHub API 返回 HTTP ${mcpResponse.status}（jadx-headless-mcp）`);
    const mcpRelease = await mcpResponse.json();
    const mcpAsset = (mcpRelease.assets ?? []).find((candidate) => String(candidate.name ?? '').endsWith('-all.jar'))
      ?? (mcpRelease.assets ?? []).find((candidate) => String(candidate.name ?? '').endsWith('.jar'));

    return {
      cli: { url: cliAsset.browser_download_url, filename: cliAsset.name, sizeBytes: cliAsset.size },
      mcp: mcpAsset ? { url: mcpAsset.browser_download_url, filename: mcpAsset.name, sizeBytes: mcpAsset.size } : null,
      filename: cliAsset.name,
      version: `${cliRelease.tag_name}${mcpRelease.tag_name ? ` + ${mcpRelease.tag_name}` : ''}`,
      sizeBytes: cliAsset.size + (mcpAsset?.size ?? 0),
    };
  },

  async install({ asset, signal, maxBytes, onProgress }) {
    const directory = path.join(CACHE_ROOT, 'jadx');
    const cliDirectory = path.join(directory, 'cli');

    if (asset.cli) {
      const archive = path.join(CACHE_ROOT, '.downloads', asset.cli.filename);
      if (!(await exists(archive))) {
        await downloadFirst(asset.cli.url, archive, {
          maxBytes,
          signal,
          onProgress: (progress) => onProgress?.({ phase: 'download', file: 'jadx-cli', ...progress }),
        });
      }
      const staging = path.join(CACHE_ROOT, '.staging', 'jadx-cli');
      await fs.rm(staging, { recursive: true, force: true });
      await extractArchive(archive, staging, { signal, onProgress });
      await normalizeExtraction(staging, cliDirectory);
    }

    if (asset.mcp) {
      const target = path.join(directory, 'jadx-headless-mcp.jar');
      await downloadFirst(asset.mcp.url, target, {
        maxBytes,
        signal,
        onProgress: (progress) => onProgress?.({ phase: 'download', file: 'jadx-mcp', ...progress }),
      });
    }

    const cli = await jadxCliLauncher(cliDirectory);
    return cli ?? path.join(directory, 'jadx-headless-mcp.jar');
  },
};

async function jadxCliLauncher(root) {
  if (!(await isDirectory(root))) return null;
  const preferred = process.platform === 'win32' ? ['jadx.bat', 'jadx.cmd'] : ['jadx'];
  for (const name of preferred) {
    const found = await findFile(root, (candidate) => candidate === name, { maxDepth: 5 });
    if (found) return found;
  }
  return findFile(root, (candidate) => candidate === 'jadx' || candidate === 'jadx.bat', { maxDepth: 5 });
}

const apktool = {
  id: 'apktool',
  title: 'apktool',
  directory: 'apktool',
  envVar: 'REA_APKTOOL_COMMAND',
  sizeMb: 4,
  pagesUrl: 'https://github.com/iBotPeaches/Apktool/releases',

  async probe() {
    const configured = process.env.REA_APKTOOL_COMMAND;
    if (configured && (await exists(configured))) {
      return { present: true, root: configured, source: 'env' };
    }
    const onPath = await which('apktool');
    if (onPath) return { present: true, root: onPath, source: 'path' };

    const wrapper = path.join(
      CACHE_ROOT,
      'apktool',
      process.platform === 'win32' ? 'apktool.bat' : 'apktool',
    );
    if (await exists(wrapper)) return { present: true, root: wrapper, source: 'cache' };
    return { present: false };
  },

  async resolve() {
    // Bitbucket answers HEAD with 403 and cannot be mirrored, so the release is
    // resolved through GitHub, which also serves the asset itself.
    try {
      const response = await fetch('https://api.github.com/repos/iBotPeaches/Apktool/releases/latest', {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-plugin-rea' },
      });
      if (response.ok) {
        const release = await response.json();
        const asset = (release.assets ?? []).find((candidate) => String(candidate.name ?? '').endsWith('.jar'));
        if (asset) {
          return { url: asset.browser_download_url, filename: asset.name, version: release.tag_name, sizeBytes: asset.size };
        }
      }
    } catch {
      // Fall through to the pinned URL; the download stage reports real errors.
    }
    return {
      url: 'https://github.com/iBotPeaches/Apktool/releases/download/v2.11.1/apktool_2.11.1.jar',
      filename: 'apktool_2.11.1.jar',
      version: '2.11.1',
      sizeBytes: null,
    };
  },

  async install({ asset, signal, maxBytes, onProgress }) {
    const directory = path.join(CACHE_ROOT, 'apktool');
    const jar = path.join(directory, asset.filename);
    await downloadFirst(asset.url, jar, {
      maxBytes,
      signal,
      onProgress: (progress) => onProgress?.({ phase: 'download', ...progress }),
    });

    // A wrapper gives REA one stable launch path per platform.
    if (process.platform === 'win32') {
      const wrapper = path.join(directory, 'apktool.bat');
      await fs.writeFile(wrapper, `@echo off\r\njava -jar "${jar}" %*\r\n`, 'utf8');
      return wrapper;
    }
    const wrapper = path.join(directory, 'apktool');
    await fs.writeFile(wrapper, `#!/bin/sh\nexec java -jar "${jar}" "$@"\n`, 'utf8');
    await fs.chmod(wrapper, 0o755);
    return wrapper;
  },
};

const frida = {
  id: 'frida',
  title: 'Frida',
  directory: 'frida',
  envVar: null,
  advisory: true,
  sizeMb: null,
  pagesUrl: 'https://frida.re/docs/installation/',

  async probe() {
    const resolved = await which('frida');
    if (resolved) return { present: true, root: resolved, source: 'path', version: null };

    const packageRoots = [
      path.join(process.env.APPDATA ?? '', 'npm', 'node_modules', 'frida'),
      path.join(os.homedir(), '.npm-global', 'lib', 'node_modules', 'frida'),
      '/usr/local/lib/node_modules/frida',
      '/opt/homebrew/lib/node_modules/frida',
    ].filter((candidate) => candidate.length > 0);

    for (const root of packageRoots) {
      const manifest = path.join(root, 'package.json');
      if (!(await exists(manifest))) continue;
      try {
        const { version } = JSON.parse(await fs.readFile(manifest, 'utf8'));
        return { present: true, root, version: version ?? null, source: 'npm-package' };
      } catch {
        // Unreadable manifest is not proof of a usable install.
      }
    }
    return { present: false, advisory: true };
  },

  async resolve() {
    return { packageSpec: 'frida@17.23.2', version: '17.23.2' };
  },

  async install({ signal, onProgress }) {
    onProgress?.({ phase: 'install', message: 'npm install -g frida' });

    const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const args = ['install', '-g', 'frida@17.23.2'];

    // The npm CLI is a Node script, so run it through the current node binary:
    // no shell, no quoting, no EINVAL from spawning a .cmd.
    const result = (await exists(npmCli))
      ? await run(process.execPath, [npmCli, ...args], { signal, timeoutMs: 600_000 })
      : await runShell((await which('npm')) ?? 'npm', args, { signal, timeoutMs: 600_000 });

    if (!result.ok) throw new Error(`npm 安装失败：${firstLine(result.stderr || result.message)}`);
    return 'global npm prefix';
  },
};

export const PROVIDERS = [ghidra, jadx, apktool, frida];

export async function probeAll() {
  const [java, ...results] = await Promise.all([
    probeJava(),
    ...PROVIDERS.map(async (provider) => {
      try {
        return {
          id: provider.id,
          title: provider.title,
          sizeMb: provider.sizeMb,
          pagesUrl: provider.pagesUrl,
          ...(await provider.probe()),
        };
      } catch (error) {
        return {
          id: provider.id,
          title: provider.title,
          sizeMb: provider.sizeMb,
          pagesUrl: provider.pagesUrl,
          present: false,
          error: error.message,
        };
      }
    }),
  ]);
  return { java, providers: results, cacheRoot: CACHE_ROOT };
}

/**
 * Install every engine that is missing.
 *
 * `onProgress` receives `{ id, phase, percent, received, total, bytesPerSecond }`
 * for each engine in turn. The return value lists one outcome per engine, so a
 * partial success is reported honestly rather than as a single pass/fail.
 */
export async function installEngines({
  only,
  maxProviderDownloadMb = 2048,
  signal,
  onProgress,
} = {}) {
  const selected = only?.length ? PROVIDERS.filter((provider) => only.includes(provider.id)) : PROVIDERS;
  const maxBytes = maxProviderDownloadMb > 0 ? maxProviderDownloadMb * 1048576 : undefined;
  const outcomes = [];

  for (const provider of selected) {
    if (signal?.aborted) {
      outcomes.push({ id: provider.id, title: provider.title, status: 'cancelled' });
      continue;
    }

    let current;
    try {
      current = await provider.probe();
    } catch (error) {
      outcomes.push({ id: provider.id, title: provider.title, status: 'failed', detail: error.message });
      continue;
    }

    if (current.present) {
      outcomes.push({
        id: provider.id,
        title: provider.title,
        status: 'already-present',
        location: current.root,
        source: current.source,
      });
      continue;
    }

    onProgress?.({ id: provider.id, phase: 'resolve', percent: 0 });
    try {
      const asset = await provider.resolve({ signal });
      const location = await provider.install({
        asset,
        signal,
        maxBytes,
        onProgress: (progress) => onProgress?.({ id: provider.id, ...progress }),
      });

      // Verify rather than trust the install call: an engine that cannot be
      // found afterwards is a failure, whatever the download reported.
      const verification = await provider.probe();
      if (!verification.present) {
        outcomes.push({
          id: provider.id,
          title: provider.title,
          status: provider.advisory ? 'advisory-incomplete' : 'failed',
          detail: `已写入 ${location}，但复检仍未发现可用安装`,
        });
        continue;
      }

      outcomes.push({
        id: provider.id,
        title: provider.title,
        status: 'installed',
        location: verification.root ?? location,
        version: asset.version ?? null,
        envVar: provider.envVar,
      });
      onProgress?.({ id: provider.id, phase: 'done', percent: 100 });
    } catch (error) {
      // A pause or cancel is a user decision, not a failure. Reporting it as
      // `failed` would make the panel render an error for a deliberate stop.
      if (error?.aborted || signal?.aborted) {
        outcomes.push({ id: provider.id, title: provider.title, status: 'cancelled' });
        onProgress?.({ id: provider.id, phase: 'paused' });
        continue;
      }
      outcomes.push({
        id: provider.id,
        title: provider.title,
        status: provider.advisory ? 'advisory-incomplete' : 'failed',
        detail: error.message,
      });
      onProgress?.({ id: provider.id, phase: 'failed' });
    }
  }

  return { outcomes, environment: providerEnvironment() };
}

/**
 * Disk usage of one engine directory, or 0 when absent.
 *
 * Reported before an uninstall so the user sees what they reclaim, and after a
 * partially failed install so a broken half-download is visible.
 */
async function directorySize(root) {
  let total = 0;
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.pop();
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
      } else if (entry.isFile()) {
        try {
          total += (await fs.stat(full)).size;
        } catch {
          // A file that vanished mid-walk contributes nothing.
        }
      }
    }
  }
  return total;
}

/** Engines that can be removed safely, with the paths each one owns. */
const UNINSTALLABLE = {
  ghidra: {
    // Only the directory this plugin manages. A Ghidra the user installed
    // elsewhere is never touched: removing a shared tool would break work the
    // plugin knows nothing about.
    paths: () => [path.join(CACHE_ROOT, 'ghidra')],
    // Downloaded archives live here and are safe to drop with the engine.
    cleanup: () => [path.join(CACHE_ROOT, '.downloads'), path.join(CACHE_ROOT, '.staging')],
  },
  jadx: {
    paths: () => [path.join(CACHE_ROOT, 'jadx')],
    cleanup: () => [path.join(CACHE_ROOT, '.downloads'), path.join(CACHE_ROOT, '.staging')],
  },
  apktool: {
    paths: () => [path.join(CACHE_ROOT, 'apktool')],
    cleanup: () => [path.join(CACHE_ROOT, '.downloads'), path.join(CACHE_ROOT, '.staging')],
  },
  frida: {
    // Frida is a global npm package, not a directory this plugin owns. Only
    // report how to remove it; uninstalling another project's dependency would
    // be a destructive surprise.
    npm: 'frida',
    paths: () => [],
    cleanup: () => [],
  },
};

/**
 * Report what an uninstall would remove, without removing anything. The panel
 * calls this first so the confirmation shows a real byte count.
 */
export async function inspectUninstall(only) {
  const ids = only?.length ? only : Object.keys(UNINSTALLABLE);
  const entries = [];

  for (const id of ids) {
    const spec = UNINSTALLABLE[id];
    const provider = PROVIDERS.find((candidate) => candidate.id === id);
    if (!spec || !provider) {
      entries.push({ id, removable: false, reason: '未知引擎' });
      continue;
    }

    const probe = await provider.probe().catch(() => ({ present: false }));
    const owned = spec.paths();
    let bytes = 0;
    for (const target of owned) bytes += await directorySize(target);

    entries.push({
      id,
      title: provider.title,
      // `present` covers both a managed copy and one found elsewhere; `owned`
      // distinguishes what this plugin can actually delete.
      present: probe.present === true,
      managedByPlugin: owned.length > 0,
      location: probe.root ?? owned[0] ?? null,
      bytes,
      npmCommand: spec.npm ? `npm uninstall -g ${spec.npm}` : null,
      removable: spec.paths().length > 0,
      reason: spec.npm
        ? `Frida 是全局 npm 包，请手动执行 npm uninstall -g ${spec.npm} 卸载`
        : null,
    });
  }

  return {
    ok: true,
    entries,
    reclaimableBytes: entries.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0),
  };
}

/**
 * Remove the engine directories this plugin installed.
 *
 * Only paths under `CACHE_ROOT` are touched. An engine found at an external
 * location (an operator-exported `GHIDRA_INSTALL_DIR`, a system install) is
 * reported but never deleted, because deleting a tool shared with other work
 * would be unrecoverable.
 */
export async function uninstallEngines({ only, signal } = {}) {
  const ids = only?.length ? only : Object.keys(UNINSTALLABLE);
  const outcomes = [];

  for (const id of ids) {
    const spec = UNINSTALLABLE[id];
    const provider = PROVIDERS.find((candidate) => candidate.id === id);

    if (!spec || !provider) {
      outcomes.push({ id, status: 'failed', detail: '未知引擎' });
      continue;
    }

    if (spec.npm) {
      outcomes.push({
        id,
        title: provider.title,
        status: 'external',
        detail: `Frida 是全局 npm 包，请在终端执行 ${spec.npm ? `npm uninstall -g ${spec.npm}` : 'npm uninstall -g frida'}`,
      });
      continue;
    }

    if (signal?.aborted) {
      outcomes.push({ id, title: provider.title, status: 'cancelled' });
      continue;
    }

    const owned = spec.paths();
    let freed = 0;
    const removed = [];

    for (const target of owned) {
      // Defensive: every path must resolve inside the managed cache root.
      const resolved = path.resolve(target);
      if (!resolved.startsWith(path.resolve(CACHE_ROOT) + path.sep)) {
        outcomes.push({
          id,
          title: provider.title,
          status: 'refused',
          detail: `拒绝删除缓存目录之外的路径：${resolved}`,
        });
        continue;
      }
      const size = await directorySize(resolved);
      await fs.rm(resolved, { recursive: true, force: true });
      freed += size;
      removed.push(resolved);
    }

    // Downloaded archives are shared across engines; drop them only when the
    // engine's own directory was actually removed.
    if (removed.length > 0) {
      for (const temp of spec.cleanup()) {
        const resolved = path.resolve(temp);
        if (!resolved.startsWith(path.resolve(CACHE_ROOT) + path.sep)) continue;
        await fs.rm(resolved, { recursive: true, force: true }).catch(() => {});
      }
    }

    const verification = await provider.probe().catch(() => ({ present: false }));

    outcomes.push({
      id,
      title: provider.title,
      status: verification.present ? 'still-present' : 'removed',
      removed,
      freedBytes: freed,
      // A copy found outside the cache survives by design; naming it prevents
      // "I uninstalled it but it still shows READY".
      surviving: verification.present ? (verification.root ?? null) : null,
      detail: verification.present
        ? `插件管理的副本已删除，但在 ${verification.root ?? '其他位置'} 仍有安装，未被改动`
        : null,
    });
  }

  return { outcomes, environment: providerEnvironment() };
}

/** Environment variables the MCP launch needs. Only paths that exist are
 * returned, so a stale value cannot make REA report a configured-but-broken
 * engine.
 */
/**
 * Locate a JDK this plugin installed itself.
 *
 * Synchronous on purpose: providerEnvironment() runs during activation and its
 * result is merged into a plain object, so it cannot await. A missing private
 * JDK simply leaves the system Java in effect.
 */
function findPrivateJdkHome() {
  const root = path.join(os.homedir(), '.dsh', 'rea-jdk');
  try {
    for (const entry of readdirSync(root)) {
      const home = path.join(root, entry);
      const java = path.join(home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
      if (existsSync(java)) return home;
    }
  } catch {
    // No private JDK.
  }
  return null;
}

export function providerEnvironment() {
  const env = {};

  /**
   * A private JDK 21 wins over the system Java for the processes this plugin
   * launches. Ghidra 11.2+ refuses to start on 17, and changing JAVA_HOME
   * globally would change every other program on the machine — so the JDK the
   * panel installs is published here, scoped to the child processes we spawn.
   */
  const privateJdk = findPrivateJdkHome();
  if (privateJdk) {
    env.JAVA_HOME = privateJdk;
    env.REA_JAVA_HOME = privateJdk;
  }

  const ghidraRoot = path.join(CACHE_ROOT, 'ghidra');
  for (const launcher of ['ghidraRun', 'ghidraRun.bat', 'support/analyzeHeadless', 'support/analyzeHeadless.bat']) {
    try {
      accessSync(path.join(ghidraRoot, launcher));
      env.GHIDRA_INSTALL_DIR = ghidraRoot;
      break;
    } catch {
      // Try the next launcher layout.
    }
  }

  const jar = path.join(CACHE_ROOT, 'jadx', 'jadx-headless-mcp.jar');
  try {
    accessSync(jar);
    env.REA_JADX_MCP_JAR = jar;
  } catch {
    // Not installed yet.
  }

  const apktoolLauncher = path.join(CACHE_ROOT, 'apktool', process.platform === 'win32' ? 'apktool.bat' : 'apktool');
  try {
    accessSync(apktoolLauncher);
    env.REA_APKTOOL_COMMAND = apktoolLauncher;
  } catch {
    // Not installed yet.
  }

  return env;
}

/** Only keys REA consumes, so a config typo is dropped rather than silently dead. */
export function readConfiguredProviderEnv(providerEnv) {
  const allowed = new Set([
    'GHIDRA_INSTALL_DIR',
    'REA_JADX_MCP_JAR',
    'REA_APKTOOL_COMMAND',
    'REA_IDA_MCP_CONFIG',
    'REA_KUNA_COMMAND',
    'REA_TSHARK_COMMAND',
    'REA_CAPINFOS_COMMAND',
    'REA_SIGROK_COMMAND',
    'REA_WABT_BIN_DIRECTORY',
    'REA_ADB_PATH',
    'REA_APKTOOL_JAVA',
  ]);
  const env = {};
  for (const [key, value] of Object.entries(providerEnv ?? {})) {
    if (!allowed.has(key)) continue;
    if (typeof value !== 'string' || value.trim().length === 0) continue;
    env[key] = value;
  }
  return env;
}

export function describeOutcome(outcome) {
  const prefix = `${outcome.id}: ${outcome.status}`;
  if (outcome.location) return `${prefix} (${outcome.location})`;
  if (outcome.detail) return `${prefix} — ${outcome.detail}`;
  return prefix;
}

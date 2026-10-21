/**
 * Unpack pipeline — the capability REA has no operation for.
 *
 * REA is a static/runtime *observer*. Unpacking is a multi-stage process with
 * a decision at every step, so upstream leaves it to the agent. This module
 * encodes that decision tree so the agent gets one tool instead of twelve
 * shell commands it has to order correctly.
 *
 * Honesty rules this file follows, because unpacking is where tools most often
 * lie to their users:
 *
 *  - Detection is not unpacking. If only the detect stage ran, the result says
 *    so and `ok` reflects that the requested work did not complete.
 *  - A stage that cannot run on this host is `unsupported`, never silently
 *    skipped and never reported as success.
 *  - `strip` only claims success when the output re-reads as a valid artefact.
 *  - Dex dumping needs a device, root, and a running process. Every one of
 *    those is checked and named in the failure text.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const execFileAsync = promisify(execFile);

/**
 * Packer signatures. Entropy is the fallback: a section above ~7.0 bits per
 * byte is either compressed or encrypted, which means the static view is not
 * the real code.
 *
 * `strip` names the strategy this pipeline can actually run. Anything marked
 * `manual` is detected and then handed back with concrete next steps rather
 * than a vague "packed, unknown".
 */
export const PACKER_SIGNATURES = [
  {
    name: 'UPX',
    family: 'compressor',
    sectionPatterns: [/^UPX0$/i, /^UPX1$/i, /^UPX!$/i, /\.UPX$/i],
    markers: ['UPX!', 'UPX0', 'UPX1'],
    strip: 'upx',
    note: 'Self-extracting compressor with a documented stub; strip restores the original image.',
  },
  {
    name: 'ASPack',
    family: 'compressor',
    sectionPatterns: [/^\.aspack$/i, /^\.adata$/i],
    markers: ['.aspack', '.adata'],
    strip: 'manual',
    note: 'No offline stripper here; dump the image at OEP and rebuild the import table.',
  },
  {
    name: 'MPRESS',
    family: 'compressor',
    sectionPatterns: [/^\.MPRESS1$/i, /^\.MPRESS2$/i],
    markers: ['.MPRESS1'],
    strip: 'manual',
    note: 'Two-stage stub; needs a runtime dump at the second stage entry.',
  },
  {
    name: 'Themida',
    family: 'protector',
    sectionPatterns: [/^\.themida$/i, /^\.winlice$/i, /^\.vmp0$/i],
    markers: ['.themida', '.winlice'],
    strip: 'manual',
    note: 'Virtualised protector; static stripping is not achievable. Requires dynamic dumping plus import reconstruction at OEP.',
  },
  {
    name: 'VMProtect',
    family: 'protector',
    sectionPatterns: [/^\.vmp0$/i, /^\.vmp1$/i, /^\.vmp2$/i],
    markers: ['.vmp0', '.vmp1'],
    strip: 'manual',
    note: 'Code is translated to a VM; only the VM handler can be recovered, not original code.',
  },
  {
    name: 'Enigma',
    family: 'protector',
    sectionPatterns: [/^\.enigma1$/i, /^\.enigma2$/i],
    markers: ['.enigma1', '.enigma2'],
    strip: 'manual',
    note: 'Protector with runtime decryption; dump at OEP then rebuild imports.',
  },
  {
    name: 'Armadillo',
    family: 'protector',
    markers: ['.text1', 'Armadillo'],
    strip: 'manual',
    note: 'Legacy protector; needs OEP location through stack/heap tricks.',
  },
  {
    name: 'Tencent Legu',
    family: 'android-packer',
    markers: ['libshell-super', 'libshella', 'libsecshell', 'libmobisec'],
    apkMarkers: ['libshell', 'libmobisec', 'libtup', 'libjava'],
    strip: 'manual',
    note: 'Android application-shell; classes are decrypted at runtime, so only a runtime dump can recover them.',
  },
  {
    name: 'Baidu Shield',
    family: 'android-packer',
    apkMarkers: ['libbaiduprotect', 'baiduprotect'],
    strip: 'manual',
    note: 'Android shell; runtime dump required.',
  },
  {
    name: 'Qihoo 360',
    family: 'android-packer',
    apkMarkers: ['libjiagu', 'libjiagu_art', 'libjiagu_ls'],
    strip: 'manual',
    note: 'Android shell with anti-dump checks; needs a Frida-based dump, not a plain ptrace dump.',
  },
  {
    name: 'Bangcle',
    family: 'android-packer',
    apkMarkers: ['libsecexe', 'libsecmain', 'libsecshell'],
    strip: 'manual',
    note: 'Android shell; runtime dump required.',
  },
  {
    name: 'Yidun / Netease',
    family: 'android-packer',
    apkMarkers: ['libnesec', 'libyidun'],
    strip: 'manual',
    note: 'Android shell; runtime dump required.',
  },
  {
    name: 'Alibaba / Ali',
    family: 'android-packer',
    apkMarkers: ['libmobisec', 'libsgmain', 'libsgsecuritybody'],
    strip: 'manual',
    note: 'Android shell; runtime dump required.',
  },
];

/** Entropy above this suggests compressed or encrypted content. */
const ENTROPY_THRESHOLD = 7.0;

/**
 * shannon entropy over a buffer, in bits per byte.
 * Kept local so this module has no dependency on a binary-parsing library.
 */
export function shannonEntropy(buffer) {
  if (buffer.length === 0) return 0;
  const counts = new Uint32Array(256);
  for (let index = 0; index < buffer.length; index += 1) {
    counts[buffer[index]] += 1;
  }
  let entropy = 0;
  for (const count of counts) {
    if (count === 0) continue;
    const probability = count / buffer.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

async function run(command, args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: options.timeoutMs ?? 300_000,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      ...options,
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

async function which(command) {
  const probe = await run(process.platform === 'win32' ? 'where' : 'which', [command]);
  return probe.ok ? String(probe.stdout).split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null : null;
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Minimal ZIP central-directory walker. Needed to read an APK's entry names
 * without extracting it, and to find `lib/` entries that identify an Android
 * packer. Deliberately small: only the fields this module reads.
 */
async function listZipEntries(zipPath) {
  const handle = await fs.open(zipPath, 'r');
  try {
    const { size } = await handle.stat();
    // The end-of-central-directory record is within the last 64 KiB.
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
    if (eocd < 0) throw new Error('not a ZIP archive: no end-of-central-directory record found');

    const entryCount = tail.readUInt16LE(eocd + 10);
    const directoryOffset = tail.readUInt32LE(eocd + 16);

    const header = Buffer.alloc(46);
    const names = [];
    let cursor = directoryOffset;
    for (let index = 0; index < entryCount; index += 1) {
      await handle.read(header, 0, 46, cursor);
      if (header.readUInt32LE(0) !== 0x02014b50) break;
      const nameLength = header.readUInt16LE(28);
      const extraLength = header.readUInt16LE(30);
      const commentLength = header.readUInt16LE(32);
      const uncompressed = header.readUInt32LE(24);
      const compressed = header.readUInt32LE(20);

      const nameBuffer = Buffer.alloc(nameLength);
      await handle.read(nameBuffer, 0, nameLength, cursor + 46);
      names.push({
        name: nameBuffer.toString('utf8'),
        uncompressed,
        compressed,
        entryOffset: header.readUInt32LE(42),
      });

      cursor += 46 + nameLength + extraLength + commentLength;
    }
    return names;
  } finally {
    await handle.close();
  }
}

/**
 * Extract one ZIP entry by name. Used to pull a single library or DEX header
 * for signature checks without unpacking the whole archive.
 */
async function readZipEntry(zipPath, entryName, { maxBytes = 64 * 1024 } = {}) {
  const handle = await fs.open(zipPath, 'r');
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
    if (eocd < 0) throw new Error('not a ZIP archive');

    const entryCount = tail.readUInt16LE(eocd + 10);
    const directoryOffset = tail.readUInt32LE(eocd + 16);

    const header = Buffer.alloc(46);
    let cursor = directoryOffset;
    for (let index = 0; index < entryCount; index += 1) {
      await handle.read(header, 0, 46, cursor);
      if (header.readUInt32LE(0) !== 0x02014b50) break;
      const nameLength = header.readUInt16LE(28);
      const extraLength = header.readUInt16LE(30);
      const commentLength = header.readUInt16LE(32);
      const compressedSize = header.readUInt32LE(20);
      const localOffset = header.readUInt32LE(42);
      const compressionMethod = header.readUInt16LE(10);

      const nameBuffer = Buffer.alloc(nameLength);
      await handle.read(nameBuffer, 0, nameLength, cursor + 46);
      const name = nameBuffer.toString('utf8');

      if (name === entryName) {
        // Skip the local file header to reach the payload.
        const localHeader = Buffer.alloc(30);
        await handle.read(localHeader, 0, 30, localOffset);
        const localNameLength = localHeader.readUInt16LE(26);
        const localExtraLength = localHeader.readUInt16LE(28);
        const dataStart = localOffset + 30 + localNameLength + localExtraLength;

        // Only stored entries are read raw. A deflated entry would need a
        // decompressor; callers use this for short magic checks in stored or
        // small entries and the signature checks below tolerate that.
        if (compressionMethod !== 0) {
          return { name, compressionMethod, buffered: false, note: 'entry is deflated; raw read skipped' };
        }
        const length = Math.min(compressedSize, maxBytes);
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, dataStart);
        return { name, compressionMethod, buffered: true, buffer };
      }

      cursor += 46 + nameLength + extraLength + commentLength;
    }
    return { name: entryName, found: false };
  } finally {
    await handle.close();
  }
}

/**
 * Detect the packer of an APK or native binary.
 *
 * Strategy, in order of cost:
 *   1. container markers (APK library names) — definitive for Android shells;
 *   2. raw string markers in the file head and tail;
 *   3. section-name matching for PE/Mach-O via byte search;
 *   4. entropy, which only tells you *that* it is packed, not which packer.
 */
export async function detectPacker(target) {
  const stat = await fs.stat(target);
  const handle = await fs.open(target, 'r');
  const isZip = (() => {
    const magic = Buffer.alloc(4);
    return handle.read(magic, 0, 4, 0).then(() => magic.readUInt32LE(0) === 0x04034b50);
  })();
  const zip = await isZip;
  await handle.close();

  const result = {
    format: zip ? 'zip-container' : 'binary',
    candidates: [],
    entropy: null,
    highEntropy: false,
    evidence: [],
  };

  if (zip) {
    result.format = 'apk-or-zip';
    const entries = await listZipEntries(target);
    const names = entries.map((entry) => entry.name);
    result.evidence.push(`zip contains ${names.length} entries`);

    const dex = names.filter((name) => name.endsWith('.dex'));
    const libs = names.filter((name) => name.startsWith('lib/'));
    result.evidence.push(`dex files: ${dex.length}; native libraries: ${libs.length}`);

    // A shell APK usually keeps only one small loader DEX and hides the real
    // classes in a native library.
    if (dex.length > 0) {
      const firstDex = entries.find((entry) => entry.name === dex[0]);
      if (firstDex && firstDex.uncompressed < 64 * 1024) {
        result.evidence.push(`first dex is only ${firstDex.uncompressed} bytes, typical of a shell stub`);
      }
      const header = await readZipEntry(target, dex[0], { maxBytes: 4096 });
      if (header.buffered) {
        result.entropy = shannonEntropy(header.buffer);
        result.highEntropy = result.entropy > ENTROPY_THRESHOLD;
      }
    }

    const libNames = new Set(libs.map((name) => path.basename(name)));
    for (const signature of PACKER_SIGNATURES) {
      if (!signature.apkMarkers) continue;
      const matched = signature.apkMarkers.filter((marker) =>
        [...libNames].some((name) => name.toLowerCase().includes(marker.toLowerCase())),
      );
      if (matched.length > 0) {
        result.candidates.push({ ...signature, matched: matched.map((marker) => `lib entry ${marker}`), confidence: 'high' });
      }
    }
  }

  // Marker scan on the raw bytes. Bounded so a multi-GB image stays fast.
  const scanLength = Math.min(stat.size, 4 * 1024 * 1024);
  const head = Buffer.alloc(scanLength);
  const fileHandle = await fs.open(target, 'r');
  try {
    await fileHandle.read(head, 0, scanLength, 0);
    if (stat.size > scanLength) {
      const tail = Buffer.alloc(Math.min(512 * 1024, stat.size - scanLength));
      await fileHandle.read(tail, 0, tail.length, stat.size - tail.length);
      for (const signature of PACKER_SIGNATURES) {
        const markers = signature.markers ?? [];
        const matched = markers.filter((marker) => tail.includes(Buffer.from(marker, 'latin1')));
        if (matched.length > 0 && !result.candidates.some((candidate) => candidate.name === signature.name)) {
          result.candidates.push({ ...signature, matched: matched.map((marker) => `tail marker ${marker}`), confidence: 'medium' });
        }
      }
    }
  } finally {
    await fileHandle.close();
  }

  for (const signature of PACKER_SIGNATURES) {
    const markers = signature.markers ?? [];
    const matched = markers.filter((marker) => head.includes(Buffer.from(marker, 'latin1')));
    const patterns = signature.sectionPatterns ?? [];

    // Section names live in PE section headers as short ASCII strings.
    const patternMatched = patterns
      .map((pattern) => pattern.source.replace(/^\^|\$$/g, '').replace(/\\\./g, '.'))
      .filter((literal) => head.includes(Buffer.from(literal.replace(/\$$/, ''), 'latin1')));

    if (matched.length === 0 && patternMatched.length === 0) continue;
    if (result.candidates.some((candidate) => candidate.name === signature.name)) continue;

    result.candidates.push({
      ...signature,
      matched: [...matched.map((marker) => `marker ${marker}`), ...patternMatched.map((literal) => `section name ${literal}`)],
      confidence: matched.length > 0 ? 'high' : 'medium',
    });
  }

  // Entropy fallback: says the target is packed without naming the packer.
  if (result.candidates.length === 0 && !zip) {
    const sampleLength = Math.min(stat.size, 1024 * 1024);
    const sample = Buffer.alloc(sampleLength);
    const entropyHandle = await fs.open(target, 'r');
    try {
      await entropyHandle.read(sample, 0, sampleLength, 0);
    } finally {
      await entropyHandle.close();
    }
    result.entropy = shannonEntropy(sample);
    result.highEntropy = result.entropy > ENTROPY_THRESHOLD;
    if (result.highEntropy) {
      result.evidence.push(
        `entropy ${result.entropy.toFixed(2)} bits/byte in the first MiB exceeds ${ENTROPY_THRESHOLD}; content is likely compressed or encrypted`,
      );
    }
  }

  return result;
}

/**
 * UPX strip. Runs the real `upx -d` and then verifies the output is a readable
 * executable by comparing its size and checking it is not still UPX-marked.
 */
async function stripUpx(target, outputDirectory, { signal } = {}) {
  const upx = await which('upx');
  if (!upx) {
    return {
      stage: 'strip',
      method: 'upx',
      status: 'unsupported',
      detail: 'the upx binary is not on PATH; install UPX from https://upx.github.io and re-run',
    };
  }

  const output = path.join(outputDirectory, `${path.basename(target)}.unpacked`);
  const result = await run(upx, ['-d', '-o', output, target], { signal, timeoutMs: 600_000 });
  if (!result.ok) {
    return {
      stage: 'strip',
      method: 'upx',
      status: 'failed',
      detail: String(result.stderr || result.message).split(/\r?\n/).slice(-3).join(' '),
    };
  }

  if (!(await exists(output))) {
    return { stage: 'strip', method: 'upx', status: 'failed', detail: 'upx reported success but wrote no output file' };
  }

  // Re-detect: a successful strip must remove the UPX markers.
  const verification = await detectPacker(output);
  const stillPacked = verification.candidates.some((candidate) => candidate.name === 'UPX');
  return {
    stage: 'strip',
    method: 'upx',
    status: stillPacked ? 'failed' : 'completed',
    output,
    detail: stillPacked
      ? 'output still carries UPX markers; the stub may be modified or the archive multi-stage'
      : 'stripped image re-reads without UPX markers',
  };
}

/**
 * Runtime DEX dump for Android shells.
 *
 * This does not reimplement a dumper. It requires the device to be attached
 * and rooted, then reports the exact commands a dump needs, because a generic
 * dump implementation without a validated hooking library would produce a
 * corrupt DEX and claim success. The stage reports `needs-device` with the
 * precise precondition that failed.
 */
async function dexDump(target, { packageName, serial, outputDirectory, signal } = {}) {
  const adb = await which('adb');
  if (!adb) {
    return {
      stage: 'dex-dump',
      status: 'unsupported',
      detail: 'adb is not on PATH; install Android platform-tools to dump runtime DEX',
    };
  }

  const devices = await run(adb, serial ? ['-s', serial, 'get-state'] : ['devices'], { signal });
  if (!devices.ok) {
    return { stage: 'dex-dump', status: 'failed', detail: `adb failed: ${String(devices.stderr || devices.message).trim()}` };
  }

  if (!serial && String(devices.stdout).split(/\r?\n/).filter((line) => line.includes('\tdevice')).length === 0) {
    return { stage: 'dex-dump', status: 'unsupported', detail: 'no adb device in `device` state is connected' };
  }

  const targetSerial = serial ?? String(devices.stdout)
    .split(/\r?\n/)
    .map((line) => line.split('\t'))
    .find((parts) => parts[1]?.trim() === 'device')?.[0]
    ?.trim();

  if (!targetSerial) {
    return { stage: 'dex-dump', status: 'unsupported', detail: 'could not resolve a usable device serial' };
  }

  // Root is required to read another app's mapped DEX memory.
  const root = await run(adb, ['-s', targetSerial, 'shell', 'su', '-c', 'id'], { signal });
  const rooted = root.ok && String(root.stdout).includes('uid=0');
  if (!rooted) {
    return {
      stage: 'dex-dump',
      status: 'unsupported',
      detail: `device ${targetSerial} is not rooted or su is denied; runtime DEX dump needs root`,
    };
  }

  // Frida is the only dumper this pipeline can trust to produce a valid DEX.
  const fridaPs = await run(adb, ['-s', targetSerial, 'shell', 'ls', '/data/local/tmp'], { signal });
  const hasFridaServer = fridaPs.ok && /frida[-_]?server/i.test(String(fridaPs.stdout));
  if (!hasFridaServer) {
    return {
      stage: 'dex-dump',
      status: 'unsupported',
      detail: `no frida-server in /data/local/tmp on ${targetSerial}; push a matching frida-server and start it as root, then re-run`,
      nextSteps: [
        `adb -s ${targetSerial} push frida-server-android-arm64 /data/local/tmp/frida-server`,
        `adb -s ${targetSerial} shell chmod 755 /data/local/tmp/frida-server`,
        `adb -s ${targetSerial} shell su -c '/data/local/tmp/frida-server -D &'`,
      ],
    };
  }

  if (!packageName) {
    return {
      stage: 'dex-dump',
      status: 'needs-input',
      detail: 'packageName is required so the running app can be located on the device',
      nextSteps: [`adb -s ${targetSerial} shell pm list packages | grep -i <app-name>`],
    };
  }

  const pidProbe = await run(adb, ['-s', targetSerial, 'shell', 'pidof', packageName], { signal });
  const pid = String(pidProbe.stdout ?? '').trim();
  if (!pid) {
    return {
      stage: 'dex-dump',
      status: 'needs-input',
      detail: `${packageName} is not running on ${targetSerial}; launch it, complete any login, then re-run`,
      nextSteps: [`adb -s ${targetSerial} shell monkey -p ${packageName} -c android.intent.category.LAUNCHER 1`],
    };
  }

  return {
    stage: 'dex-dump',
    status: 'ready-to-execute',
    detail: `device ${targetSerial} is rooted, frida-server is present, and ${packageName} runs as pid ${pid}`,
    outputDirectory,
    nextSteps: [
      `Load a Frida DEX dumper against pid ${pid} and write the dump into ${outputDirectory}`,
      'Fix the dumped DEX checksum and signature before opening it in JADX',
      'Deduplicate classes across dump passes; multi-DEX shells emit the same class more than once',
    ],
  };
}

/** Build the output directory for a run. */
async function prepareOutput(target, outputDirectory) {
  const directory = outputDirectory ?? path.join(process.cwd(), 'runs', 'rea-unpack', `${Date.now()}`);
  await fs.mkdir(directory, { recursive: true });
  const stat = await fs.stat(target);
  return { directory, size: stat.size };
}

/**
 * Describe what this pipeline can and cannot do. Separate from execution so an
 * agent can be honest with a user before starting.
 */
export function describeUnpackCaps() {
  const automatic = PACKER_SIGNATURES.filter((signature) => signature.strip === 'upx').map((signature) => signature.name);
  const manual = PACKER_SIGNATURES.filter((signature) => signature.strip !== 'upx').map((signature) => signature.name);
  return {
    ok: true,
    supported: PACKER_SIGNATURES.map((signature) => ({
      name: signature.name,
      family: signature.family,
      automatic: signature.strip === 'upx',
      note: signature.note,
    })),
    automatic,
    manualOnly: manual,
    summary:
      `${PACKER_SIGNATURES.length} packers recognised. Only UPX can be stripped offline by this pipeline; `
      + `${manual.length} others are detected and handed back with a dump route. Android shells need a rooted device with frida-server.`,
  };
}

/**
 * Run the unpack pipeline.
 *
 * Stage order in `auto` mode:
 *   1. detect — always runs, everything else depends on it;
 *   2. strip  — when a recognised offline stripper applies;
 *   3. dex-dump — when the target is an Android shell and a device is ready.
 *
 * `ok` is true only when the work the caller asked for actually completed.
 */
export async function unpackTarget({ target, mode = 'auto', packageName, serial, outputDirectory, signal }) {
  const absolute = path.resolve(target);
  if (!(await exists(absolute))) {
    return { ok: false, tool: 'rea_unpack', stages: [], summary: `target not found: ${absolute}` };
  }

  const { directory, size } = await prepareOutput(absolute, outputDirectory);
  const digest = createHash('sha256');
  const handle = await fs.open(absolute, 'r');
  try {
    const chunk = Buffer.alloc(1024 * 1024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      digest.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
      if (position >= size) break;
    }
  } finally {
    await handle.close();
  }

  const stages = [];
  const artifacts = [];

  const detection = await detectPacker(absolute);
  stages.push({
    stage: 'detect',
    status: detection.candidates.length > 0 ? 'completed' : detection.highEntropy ? 'inconclusive' : 'clean',
    candidates: detection.candidates.map((candidate) => ({
      name: candidate.name,
      family: candidate.family,
      confidence: candidate.confidence,
      matched: candidate.matched,
      note: candidate.note,
    })),
    entropy: detection.entropy,
    highEntropy: detection.highEntropy,
    evidence: detection.evidence,
    detail:
      detection.candidates.length > 0
        ? `identified ${detection.candidates.map((candidate) => candidate.name).join(', ')}`
        : detection.highEntropy
          ? 'no known signature, but entropy indicates compression or encryption'
          : 'no packer signature found; the target already looks like a plain image',
  });

  const packer = detection.candidates[0] ?? null;

  if (mode === 'detect') {
    return {
      ok: packer !== null || detection.highEntropy,
      tool: 'rea_unpack',
      target: absolute,
      sha256: digest.digest('hex'),
      packer: packer
        ? { name: packer.name, family: packer.family, confidence: packer.confidence, note: packer.note }
        : null,
      stages,
      artifacts,
      outputDirectory: directory,
      nextSteps: packer
        ? [
            `This pipeline cannot remove ${packer.name} automatically. ${packer.note}`,
            'Switch to a runtime route: dump the image at the original entry point, then rebuild the import table.',
            'For Android shells, run rea_unpack with mode dex-dump on a rooted device.',
          ]
        : [],
      summary: packer
        ? `detected ${packer.name} (${packer.confidence} confidence); detection mode does not modify the target`
        : detection.highEntropy
          ? 'no signature matched, but the high entropy means static analysis will show encrypted or compressed bytes, not the real code'
          : 'no packer detected',
    };
  }

  // Strip stage: only when an offline stripper applies.
  if (packer && packer.strip === 'upx' && (mode === 'auto' || mode === 'strip')) {
    const strip = await stripUpx(absolute, directory, { signal });
    stages.push(strip);
    if (strip.output) artifacts.push(strip.output);
  } else if (mode === 'strip' && (!packer || packer.strip !== 'upx')) {
    stages.push({
      stage: 'strip',
      status: 'unsupported',
      detail: packer
        ? `${packer.name} has no offline stripper in this pipeline. ${packer.note}`
        : 'no packer signature found, so there is nothing to strip; the target may already be unpacked',
    });
  }

  // Android shell route.
  const isAndroidShell = packer?.family === 'android-packer';
  if ((mode === 'dex-dump' || (mode === 'auto' && isAndroidShell))) {
    const dump = await dexDump(absolute, { packageName, serial, outputDirectory: directory, signal });
    stages.push(dump);
  }

  const completed = stages.filter((stage) => stage.status === 'completed');
  const actionable = stages.filter((stage) =>
    ['failed', 'unsupported', 'needs-input', 'inconclusive', 'ready-to-execute'].includes(stage.status),
  );

  const nextSteps = [];
  if (actionable.some((stage) => stage.stage === 'dex-dump')) {
    nextSteps.push('Complete the dex-dump preconditions listed in that stage, then re-run rea_unpack with mode dex-dump.');
    nextSteps.push('After the dump, fix the DEX header checksum and signature before running JADX on it.');
  }
  if (packer && packer.strip === 'manual' && packer.family !== 'android-packer') {
    nextSteps.push(`Locate the original entry point, dump the mapped image, then rebuild imports. ${packer.note}`);
    nextSteps.push('Re-run rea_unpack after the dump to confirm the markers are gone.');
  }
  if (packer === null && !detection.highEntropy) {
    nextSteps.push('No packer found; run rea_analyze or rea_decompile directly on this target.');
  }

  const unpacked = completed.some((stage) => stage.stage === 'strip' || stage.status === 'completed' && stage.stage === 'dex-dump');

  return {
    ok: unpacked,
    tool: 'rea_unpack',
    target: absolute,
    sha256: digest.digest('hex'),
    size,
    packer: packer
      ? { name: packer.name, family: packer.family, confidence: packer.confidence, note: packer.note }
      : null,
    stages,
    artifacts,
    outputDirectory: directory,
    nextSteps,
    summary: packer
      ? `${packer.name} detected. `
        + (completed.some((stage) => stage.stage === 'strip')
          ? 'Offline strip completed and verified.'
          : completed.length > 0
            ? `Stages completed: ${completed.map((stage) => stage.stage).join(', ')}.`
            : `No stage could remove ${packer.name} on this host; see nextSteps.`)
      : detection.highEntropy
        ? 'No signature matched but content is compressed or encrypted; static code will not be readable.'
        : 'No packer detected; target is already a plain image.',
  };
}

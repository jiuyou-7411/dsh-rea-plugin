/**
 * The `rea` process runner.
 *
 * One place that knows how to start the CLI, so the unified `rea` tool
 * (lib/tool-rea.js) shares the same spawn rules: argv array, UTF-8 forced on the
 * Python side, a hard timeout, both streams captured.
 *
 * The pinned upstream version is set once at activation (`setCliVersion`) rather
 * than threaded through every call, because it is a property of the install, not
 * of the individual command.
 */

import { spawn } from 'node:child_process';

/** Upstream version to resolve through npx. Set at activation. */
let pinnedVersion = '6.7.0';

/** Pin the upstream version for every subsequent spawn. */
export function setCliVersion(version) {
  if (version) pinnedVersion = String(version);
}

/** The version currently pinned. */
export function cliVersion() {
  return pinnedVersion;
}

/**
 * Run `rea <argv>` and capture both streams.
 *
 * Arguments go through as an argv array, so a path containing spaces or quotes is
 * a value and never a second command. On Windows npx is a `.cmd` shim and needs a
 * shell to resolve; that flag is set there and nowhere else, which is why callers
 * must pass caller-controlled text as separate array entries rather than as one
 * pre-joined string.
 */
export function runRea(argv, { timeoutMs = 600_000 } = {}) {
  return new Promise((resolve, reject) => {
    const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const fullArgs = ['-y', `rea-agents@${pinnedVersion}`, ...argv];

    const child = spawn(command, fullArgs, {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: process.platform === 'win32',
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      try { child.kill(); } catch { /* already gone */ }
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`无法启动 rea 命令行：${error.message}`));
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      if (killed) {
        reject(new Error(`rea ${argv[0] ?? ''} 超时（${Math.round(timeoutMs / 1000)}s）已终止`));
        return;
      }
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

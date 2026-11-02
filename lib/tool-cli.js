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
import { existsSync } from 'node:fs';
import path from 'node:path';

/** Upstream version to resolve through npx. Set at activation. */
let pinnedVersion = '6.7.0';

/**
 * Locate npx's JS entry so it can be run by node instead of through a shell.
 *
 * Why this matters: on Windows `spawn('npx.cmd', args, { shell: true })` hands the
 * whole command line to cmd.exe, and Node concatenates `args` with spaces and no
 * quoting. Measured — passing `x & echo INJECTED` as one argument to this exact
 * call executed the `echo`. The model controls those arguments, so a crafted file
 * path, or a prompt-injected instruction, could run arbitrary commands on the
 * host. Running `node <npx-cli.js>` with `shell: false` removes the shell from the
 * path entirely and the same payload is inert.
 *
 * Returns null when the entry is not where npm normally puts it, so the caller can
 * fall back to the old behaviour rather than failing to start REA at all.
 */
export function resolveNpxCli() {
  const candidate = path.join(
    path.dirname(process.execPath),
    'node_modules',
    'npm',
    'bin',
    'npx-cli.js',
  );
  return existsSync(candidate) ? candidate : null;
}

/**
 * Build the command and argument vector for one REA invocation.
 *
 * Shared so every spawn site in this package goes through the same shell-free
 * path — a second call site that quietly keeps `shell: true` would reintroduce
 * the injection this exists to close.
 */
export function npxInvocation(args) {
  const cli = resolveNpxCli();
  if (cli) {
    return { command: process.execPath, args: [cli, ...args], shell: false };
  }
  // Fallback: the .cmd shim needs a shell on Windows, and that is the only case
  // where one is used at all.
  const windows = process.platform === 'win32';
  return { command: windows ? 'npx.cmd' : 'npx', args, shell: windows };
}

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
 * Arguments go through as an argv array and, on every platform where npx's JS
 * entry can be found, with no shell at all — see `resolveNpxCli` for the measured
 * reason.
 */
export function runRea(argv, { timeoutMs = 600_000 } = {}) {
  return new Promise((resolve, reject) => {
    const invocation = npxInvocation(['-y', `rea-agents@${pinnedVersion}`, ...argv]);

    const child = spawn(invocation.command, invocation.args, {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: invocation.shell,
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

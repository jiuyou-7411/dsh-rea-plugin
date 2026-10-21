/**
 * Per-package Python dependency management.
 *
 * The earlier design offered one "install all 7" button, which answered the
 * wrong question: when a single package breaks (a wheel that will not build, a
 * version conflict), the user needs to see WHICH one, install it alone, and
 * remove it again to retest. So each package is its own row with its own state.
 *
 * `importName` vs `pipName` matters: Python imports `pyelftools` and `z3`, while
 * pip installs `pyelftools` and `z3-solver`. That mismatch is itself a common
 * reason a script still reports "missing" after an apparently successful
 * install, so the table records both.
 */

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { rankMirrors } from './pip-mirrors.js';

/** The packages the vendored MobileRE scripts import. */
export const PYTHON_PACKAGES = [
  {
    // The PyPI package is 'pyelftools' but the module it installs is
    // 'elftools'. Probing the pip name reports it missing after a successful
    // install, which reads as a broken package.
    importName: 'elftools',
    pipName: 'pyelftools',
    label: 'pyelftools',
    sizeMb: 1,
    usedBy: ['so.py'],
    purpose: 'ELF 段/节解析，SO 分析基础',
  },
  {
    importName: 'capstone',
    pipName: 'capstone',
    label: 'capstone',
    sizeMb: 2,
    usedBy: ['so.py', 'emu_run.py'],
    purpose: 'ARM64/x86 反汇编引擎',
  },
  {
    importName: 'keystone',
    pipName: 'keystone-engine',
    label: 'keystone-engine',
    sizeMb: 2,
    usedBy: ['emu_run.py'],
    purpose: '汇编器，模拟执行时修补指令',
  },
  {
    importName: 'lief',
    pipName: 'lief',
    label: 'lief',
    sizeMb: 14,
    usedBy: ['unpack.py', 'so.py'],
    purpose: 'ELF/PE/DEX 读写与重打包',
  },
  {
    importName: 'z3',
    pipName: 'z3-solver',
    label: 'z3-solver',
    sizeMb: 32,
    usedBy: ['cipher_lab.py'],
    purpose: 'SMT 求解器，白盒密码逆向',
  },
  {
    importName: 'unicorn',
    pipName: 'unicorn',
    label: 'unicorn',
    sizeMb: 58,
    usedBy: ['emu_run.py', 'uniharness.py'],
    purpose: 'CPU 指令级模拟执行',
  },
  {
    importName: 'frida',
    pipName: 'frida',
    label: 'frida',
    sizeMb: 152,
    usedBy: ['frida_run.py', 'unpack.py'],
    purpose: '运行时插桩，动态 hook',
  },
];

/** Resolve the pip name for an import name. */
export function pipNameOf(importName) {
  return PYTHON_PACKAGES.find((p) => p.importName === importName)?.pipName ?? importName;
}

/** Resolve the catalogue entry for an import name. */
export function packageInfo(importName) {
  return PYTHON_PACKAGES.find((p) => p.importName === importName) ?? null;
}

/**
 * Where each package lives on disk, how big it is, and its version.
 *
 * One `python -c` for all of them: spawning Python costs ~100 ms on Windows and
 * a per-package probe would make the settings page feel broken.
 */
export async function packageInventory(python) {
  if (!python) return {};

  const names = PYTHON_PACKAGES.map((p) => p.importName);
  const script = `
import json, importlib, os, sys

out = {}
for name in ${JSON.stringify(names)}:
    try:
        m = importlib.import_module(name)
        path = getattr(m, '__file__', None)
        if path and os.path.basename(path).startswith('__init__'):
            path = os.path.dirname(path)
        size = 0
        if path:
            if os.path.isdir(path):
                for root, _dirs, files in os.walk(path):
                    for f in files:
                        try:
                            size += os.path.getsize(os.path.join(root, f))
                        except OSError:
                            pass
            else:
                try:
                    size = os.path.getsize(path)
                except OSError:
                    pass
        ver = getattr(m, '__version__', None)
        out[name] = {
            'version': str(ver) if ver is not None else None,
            'path': path,
            'sizeMb': round(size / 1048576, 1),
        }
    except Exception as exc:
        out[name] = None
print(json.dumps(out))
`;

  return new Promise((resolve) => {
    const child = spawn(python, ['-c', script], {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', () => resolve({}));
    child.on('exit', () => {
      try { resolve(JSON.parse(out.trim())); } catch { resolve({}); }
    });
  });
}

/** A paused or cancelled operation must be distinguishable from a failure. */
export class InstallAborted extends Error {
  constructor(reason = 'cancelled') {
    super(reason === 'pause' ? '已暂停' : '已取消');
    this.name = 'InstallAborted';
    this.reason = reason;
  }
}

/**
 * One pip operation, observable.
 *
 * Events:
 *   'progress' { phase, package, done, total, percent }
 *   'log'      { level, text }
 */
export class PipRunner extends EventEmitter {
  constructor({ python, mirror = null }) {
    super();
    this.python = python;
    this.mirror = mirror;
    this.child = null;
    this.aborted = false;
    this.abortReason = null;
  }

  /**
   * Install pip package names.
   *
   * Mirrors are chosen by measurement unless one is pinned: probing showed the
   * official index can be fastest on one package and stall on the next, so a
   * hardcoded preference is wrong roughly half the time.
   */
  async install(packages, { signal } = {}) {
    if (!this.python) throw new Error('未找到 Python 解释器');
    if (!packages?.length) return { installed: [], mirror: null };

    let candidates;
    if (this.mirror) {
      candidates = [{ url: this.mirror, label: this.mirror }];
    } else {
      this.emit('progress', {
        phase: 'probing', package: null, done: 0, total: packages.length, percent: 0,
      });
      const ranking = await rankMirrors(this.python);
      candidates = ranking.ranked;
      this.emit('log', {
        level: 'info',
        text: `镜像测速：${ranking.ranked.map((m) => `${m.label}(${m.measuredMs ?? '?'}ms)`).join(' → ')}`,
      });
    }

    const attempts = [];
    for (const candidate of candidates) {
      if (signal?.aborted) throw new InstallAborted(this.abortReason ?? 'cancelled');
      try {
        const result = await this.#run(
          ['-m', 'pip', 'install', '--progress-bar', 'off', '--disable-pip-version-check',
            ...packages, ...(candidate.url ? ['-i', candidate.url] : [])],
          packages,
          signal,
        );
        return { ...result, mirror: candidate };
      } catch (error) {
        if (error instanceof InstallAborted) throw error;
        attempts.push({ mirror: candidate, error });
        this.emit('log', {
          level: 'warn',
          text: `${candidate.label ?? candidate.url} 失败，换下一个源：${(error?.message ?? '').slice(0, 120)}`,
        });
      }
    }

    const detail = attempts
      .map((a) => `${a.mirror.label ?? a.mirror.url}: ${a.error.message.split('\n')[0]}`)
      .join('；');
    throw new Error(`所有镜像均失败（${attempts.length} 个）：${detail}`);
  }

  /** Remove packages by pip name. */
  async uninstall(packages, { signal } = {}) {
    if (!this.python) throw new Error('未找到 Python 解释器');
    if (!packages?.length) return { removed: [] };
    return this.#run(
      ['-m', 'pip', 'uninstall', '-y', '--disable-pip-version-check', ...packages],
      packages,
      signal,
    );
  }

  /** One pip process, parsed into progress events. */
  #run(args, packages, signal) {
    const total = packages.length;
    let done = 0;

    this.emit('progress', {
      phase: 'starting', package: null, done: 0, total, percent: 0,
    });

    return new Promise((resolve, reject) => {
      const child = spawn(this.python, args, {
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
          PYTHONUNBUFFERED: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      this.child = child;
      let tail = '';
      const stderrTail = [];

      const onAbort = () => {
        this.aborted = true;
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      const handle = (raw) => {
        const line = raw.trim();
        if (!line) return;

        const downloading = /^Downloading\s+(\S+?)-[\d.]/i.exec(line);
        if (downloading) {
          this.emit('progress', {
            phase: 'download', package: downloading[1], done, total,
            percent: Math.round((done / total) * 100),
          });
        }

        if (/^Installing collected packages:/i.test(line) || /^Uninstalling /i.test(line)) {
          this.emit('progress', {
            phase: 'extract', package: null, done, total,
            percent: Math.round((done / total) * 100),
          });
        }

        if (/^Successfully installed|^Successfully uninstalled/i.test(line)) {
          done = total;
          this.emit('progress', {
            phase: 'verify', package: null, done, total, percent: 100,
          });
        }

        this.emit('log', { level: 'info', text: line.slice(0, 300) });
      };

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        tail += chunk;
        let index;
        while ((index = tail.indexOf('\n')) >= 0) {
          handle(tail.slice(0, index));
          tail = tail.slice(index + 1);
        }
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        for (const line of String(chunk).split(/\r?\n/)) {
          const text = line.trim();
          if (!text) continue;
          stderrTail.push(text);
          if (stderrTail.length > 60) stderrTail.shift();
          this.emit('log', {
            level: /error/i.test(text) ? 'error' : 'warn',
            text: text.slice(0, 300),
          });
        }
      });

      child.on('error', (error) => {
        signal?.removeEventListener('abort', onAbort);
        reject(new Error(`无法启动 pip：${error.message}`));
      });

      child.on('exit', (code) => {
        signal?.removeEventListener('abort', onAbort);
        this.child = null;

        if (this.aborted) {
          reject(new InstallAborted(this.abortReason ?? 'cancelled'));
          return;
        }
        if (code === 0) {
          this.emit('progress', {
            phase: 'done', package: null, done: total, total, percent: 100,
          });
          resolve({ done: packages });
          return;
        }
        const detail = stderrTail.slice(-6).join('\n');
        reject(new Error(`pip 退出码 ${code}${detail ? `：${detail}` : ''}`));
      });
    });
  }

  abort(reason = 'cancelled') {
    this.abortReason = reason;
    if (this.child) {
      try { this.child.kill('SIGTERM'); } catch { /* already gone */ }
    }
  }
}

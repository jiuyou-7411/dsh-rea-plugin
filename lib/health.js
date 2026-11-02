/**
 * Service health for the workbench overview.
 *
 * The panel cannot see inside the MCP client, so this module answers the
 * question from the outside: are the `mcp__rea__*` tools actually registered in
 * this process, and how many? A registered tool means the stdio server started,
 * completed the MCP handshake, and answered `tools/list`. A missing one means
 * the launch failed — wrong Node version, `npx` blocked, package resolution
 * error — and the panel must say so instead of showing a green "ready".
 *
 * Every check returns a status plus a remediation line, because "MCP 断开" alone
 * leaves the user with nothing to do.
 */

import { probeAll, providerEnvironment, CACHE_ROOT, REA_AGENTS_VERSION } from './providers.js';

/** Minimum Node version REA accepts, matching its `engines.node` field. */
const NODE_RULES = [
  { matches: (major) => major === 22, minMinor: 19 },
  { matches: (major) => major === 24, minMinor: 11 },
  { matches: (major) => major >= 26, minMinor: 0 },
];

function checkNode() {
  const version = process.versions.node;
  const [majorText, minorText] = version.split('.');
  const major = Number(majorText);
  const minor = Number(minorText);

  const rule = NODE_RULES.find((candidate) => candidate.matches(major));
  const ok = Boolean(rule) && minor >= rule.minMinor;

  return {
    id: 'node',
    label: 'Node.js',
    // `ok` drives the dot; `warn` marks a condition that limits features but
    // does not stop the server.
    status: ok ? 'ok' : 'error',
    value: `v${version}`,
    detail: ok
      ? null
      : `REA 需要 Node 22.19+ / 24.11+ / 26+，当前 v${version} 无法启动 MCP 服务`,
    fix: ok ? null : '升级 Node.js 到 22.19 或更高版本，然后重启 Harness',
  };
}

/**
 * Check that REA is reachable through the unified tool.
 *
 * The fused design registers exactly one tool, `rea`, and routes each command
 * to the stateless CLI or to the MCP server. So "how many tools are registered"
 * is no longer the question. The questions are:
 *
 *   1. Is the `rea` tool there? Without it there is no entry point at all.
 *   2. Is the MCP channel up? The 99 commands with no CLI equivalent need it.
 *
 * The CLI channel is not probed here: running `rea --help` on every health poll
 * would spawn npx each time the panel refreshes, and the tool itself surfaces a
 * CLI failure together with its usage block when it happens.
 */
function checkMcpTools(tools, mcp = null) {
  let schemas = [];
  try {
    schemas = tools?.schemas ? tools.schemas() : [];
  } catch {
    schemas = [];
  }

  const hasEntry = schemas.some((schema) => schema?.name === 'rea');
  const state = String(mcp?.state ?? 'unknown');
  const upstream = Number(mcp?.upstreamCount ?? 0) || 0;
  const mcpReady = state === 'ready';

  if (!hasEntry) {
    return {
      id: 'mcp',
      label: 'REA 工具',
      status: 'error',
      value: '未注册',
      detail: '统一入口工具 `rea` 没有注册在进程里，REA 完全不可用',
      fix: '检查 Harness 日志里的 rea-host 行；插件可能没有加载成功',
      toolCount: 0,
    };
  }

  if (!mcpReady) {
    return {
      id: 'mcp',
      label: 'REA 工具',
      status: 'warn',
      value: '命令行可用',
      detail: `\`rea\` 已就绪，但 MCP 通道是 ${state}：有命令行实现的命令照常能用，`
        + '只有 MCP 支持的能力（Hopper GUI 操作、compare_*、Frida/GDB 会话等）暂时不可用',
      fix: '面板「服务状态」里看 MCP 一行；常见原因是 Node 版本、npx 被拦截、或首次下载超时',
      toolCount: 1,
    };
  }

  return {
    id: 'mcp',
    label: 'REA 工具',
    status: 'ok',
    value: '双通道就绪',
    detail: `\`rea\` 一个工具覆盖全部 ${upstream} 个能力：`
      + '有命令行实现的走无状态 CLI（可并行），其余走 MCP',
    fix: null,
    toolCount: 1,
  };
}

/** Java is a hard prerequisite for JADX and apktool. */
function checkJava(java) {
  return {
    id: 'java',
    label: 'Java 运行时',
    status: java?.present ? 'ok' : 'warn',
    value: java?.present ? String(java.version ?? '已安装').slice(0, 40) : '缺失',
    detail: java?.present ? null : 'JADX 与 apktool 依赖 Java，缺失时 Android 分析不可用',
    fix: java?.present ? null : '安装 JDK 17+ 并确保 java 在 PATH 中',
  };
}

/**
 * Python runtime for the MobileRE layer.
 *
 * Missing packages are reported by name rather than as a single failure: the
 * thirteen standard-library scripts still work, so this is a partial capability
 * (warn), never a hard error.
 */
function checkPython(python) {
  if (!python) {
    return {
      id: 'python',
      label: 'Python 运行时',
      status: 'warn',
      value: '未探测',
      detail: 'MobileRE 的 21 个脚本需要 Python 3.9+',
      fix: '安装 Python 3 后刷新；插件会自动发现 %LOCALAPPDATA%\Programs\Python',
    };
  }
  if (!python.present) {
    return {
      id: 'python',
      label: 'Python 运行时',
      status: 'warn',
      value: '缺失',
      detail: python.error ?? 'MobileRE 的 21 个脚本需要 Python 3.9+',
      fix: '安装 Python 3.11+，或用 config.pythonPath 指定解释器路径',
    };
  }

  const missing = python.missing ?? [];
  const core = missing.filter((name) => ['frida', 'capstone', 'elftools'].includes(name));
  const optional = missing.filter((name) => !core.includes(name));

  if (missing.length === 0) {
    return {
      id: 'python',
      label: 'Python 运行时',
      status: 'ok',
      value: python.version,
      detail: 'MobileRE 全部脚本可用',
      fix: null,
    };
  }

  const pip = missing
    .map((name) => (name === 'elftools' ? 'pyelftools' : (name === 'z3' ? 'z3-solver' : name)))
    .join(' ');

  return {
    id: 'python',
    label: 'Python 运行时',
    status: 'warn',
    value: `${python.version} · 缺 ${missing.length} 包`,
    detail: `未安装：${missing.join(', ')}。纯标准库脚本仍可用`,
    fix: `${python.command} -m pip install ${pip}`,
  };
}

function checkEngines(providers, java) {
  const ready = providers.filter((provider) => provider.present);
  const required = providers.filter((provider) => !provider.advisory);

  // JADX without Java cannot decompile, so a present jar with no runtime is not
  // "ready" in any useful sense.
  const blockedByJava = !java?.present && ready.some((provider) => provider.id === 'jadx');
  const readyCount = ready.length;
  const totalCount = providers.length;

  const status = blockedByJava
    ? 'warn'
    : readyCount === totalCount
      ? 'ok'
      : readyCount === 0
        ? 'error'
        : 'warn';

  return {
    id: 'engines',
    label: '分析引擎',
    status,
    value: `${readyCount} / ${totalCount}`,
    detail: blockedByJava
      ? 'JADX 已安装但缺少 Java，无法反编译'
      : readyCount === totalCount
        ? null
        : `未安装：${providers.filter((provider) => !provider.present).map((provider) => provider.title).join(', ')}`,
    fix: readyCount === totalCount ? null : '在工作台下方的引擎卡片上点击「一键安装」',
    readyCount,
    totalCount,
  };
}

/** Where engines live, plus whether that path is writable. */
async function checkCache(cacheRoot) {
  try {
    const fs = await import('node:fs/promises');
    await fs.mkdir(cacheRoot, { recursive: true });
    const probe = `${cacheRoot}/.write-probe`;
    await fs.writeFile(probe, 'ok');
    await fs.rm(probe, { force: true });
    return {
      id: 'cache',
      label: '引擎目录',
      status: 'ok',
      value: cacheRoot,
      detail: null,
      fix: null,
    };
  } catch (error) {
    return {
      id: 'cache',
      label: '引擎目录',
      status: 'error',
      value: cacheRoot,
      detail: `目录不可写：${error.message}`,
      fix: '检查磁盘空间与目录权限，或把引擎装到其他位置后手动设置环境变量',
    };
  }
}

/**
 * Full service-health report.
 *
 * Returned as a list so the panel renders one row per check without knowing the
 * order or the set of checks in advance.
 */
export async function buildHealth({ tools, telemetry, python = null, mcp = null }) {
  const report = await probeAll();

  const checks = [
    checkNode(),
    checkMcpTools(tools, mcp),
    checkEngines(report.providers, report.java),
    checkJava(report.java),
    checkPython(python),
    await checkCache(CACHE_ROOT),
  ];

  const counts = telemetry?.counts ?? { total: 0, failed: 0, rea: 0, reaFailed: 0 };

  /*
   * Judge this plugin by this plugin's failures.
   *
   * The check used to divide all failures by all calls, which meant an unrelated
   * `pwsh` workspace error or a web search missing its API key turned the REA
   * panel red. Measured on a live profile: 33 failures out of 120 calls, of
   * which 27 came from other plugins entirely — so the panel reported a broken
   * REA while every REA call it had made was fine.
   *
   * `counts.rea` / `counts.reaFailed` are the numbers that describe this plugin;
   * everything else is reported beside them, never folded in.
   */
  const reaRate = counts.rea > 0 ? counts.reaFailed / counts.rea : 0;
  const otherFailed = Math.max(0, counts.failed - counts.reaFailed);

  /*
   * Separate argument mistakes from real failures.
   *
   * REA's commands are path-first, and a call that forgets the path comes back
   * with a usage block — the CLI rejected the shape before doing any work. Those
   * calls did fail, but they say something about the tool description, not about
   * whether the plugin works: measured on a live profile, 3 of 8 calls were this
   * and every one of them was retried successfully by the model.
   *
   * Counting them at full weight reported "近期错误 3/8" as an error while the
   * engine, the CLI and the MCP channel were all fine. They are now reported
   * separately and judged as a warning: still visible, still actionable, not a
   * verdict that the plugin is broken.
   */
  let usageFailed = 0;
  try {
    const snapshot = typeof telemetry?.snapshot === 'function' ? telemetry.snapshot() : null;
    for (const group of snapshot?.errors ?? []) {
      const message = String(group?.message ?? '');
      const isOwn = String(group?.tool ?? '').startsWith('rea');
      if (!isOwn) continue;
      if (/用法|Usage:|参数不合法|参数不对|COMMAND_NOT_FOUND|VALIDATION_ERROR/.test(message)) {
        usageFailed += Number(group?.count ?? 0) || 0;
      }
    }
  } catch {
    usageFailed = 0;
  }
  const realFailed = Math.max(0, counts.reaFailed - usageFailed);
  const realRate = counts.rea > 0 ? realFailed / counts.rea : 0;

  checks.push({
    id: 'errors',
    label: '近期错误',
    // A high failure rate matters more than an absolute count: one failure among
    // three calls is far worse than five among two hundred.
    status: realRate > 0.25 ? 'error' : (realRate > 0.05 || usageFailed > 0) ? 'warn' : 'ok',
    value: usageFailed > 0
      ? `${realFailed} 失败 · ${usageFailed} 参数错 / ${counts.rea}`
      : `${counts.reaFailed} / ${counts.rea}`,
    detail: [
      counts.reaFailed > 0
        ? `REA 工具 ${counts.rea} 次调用中 ${counts.reaFailed} 次失败`
        : (counts.rea > 0 ? `REA 工具 ${counts.rea} 次调用全部成功` : null),
      usageFailed > 0
        ? `其中 ${usageFailed} 次是参数用法错误（命令路径优先，缺路径会被拒），模型拿到用法后可以重试`
        : null,
      otherFailed > 0 ? `另有其它插件 ${otherFailed} 次失败，不计入` : null,
    ].filter(Boolean).join('；') || null,
    fix: counts.reaFailed > 0 ? '展开下方「错误聚合」查看具体工具与原因' : null,
  });

  const worst = checks.some((check) => check.status === 'error')
    ? 'error'
    : checks.some((check) => check.status === 'warn')
      ? 'warn'
      : 'ok';

  return {
    ok: worst !== 'error',
    overall: worst,
    at: Date.now(),
    uptimeMs: Date.now() - (telemetry?.startedAt ?? Date.now()),
    checks,
    environment: providerEnvironment(),
    reaVersion: REA_AGENTS_VERSION,
    cacheRoot: CACHE_ROOT,
    platform: `${process.platform}/${process.arch}`,
  };
}

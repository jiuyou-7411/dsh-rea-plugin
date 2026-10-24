/**
 * REA workbench — the Client half.
 *
 * A first-class panel: one sidebar icon and the main column, wired the way
 * `dsh-mcp-console` and `dsh-context` are (one id addresses both a
 * `sidebar.panellist` icon and a `main` key).
 *
 * Layout is a top navigation bar, not a left rail: this plugin already lives
 * inside the DSH sidebar, so a second vertical rail would read as two sidebars
 * fighting each other. The bar carries the six sections plus the live counters
 * that matter at a glance.
 *
 * The install flow the user sees:
 *
 *   press Install → POST returns a job id → poll every 400 ms → each card grows
 *   a progress bar with bytes and speed → on completion the card flips to READY
 *   and a reload hint appears.
 *
 * Why polling and not a stream: a 543 MiB transfer outlives proxy and browser
 * request timeouts, so the work lives in a Host job and the panel only reads its
 * number. The interval is 400 ms — fast enough to look live, slow enough that a
 * three-engine install costs a few hundred requests rather than thousands.
 *
 * The call stream uses SSE instead, because those events are small, frequent,
 * and latency matters: one long-lived connection replaces hundreds of polls.
 */

window.__ModuleLoader__.load({
  id: 'dsh-rea-plugin',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback, useMemo, useRef } = React;

    const PANEL_ID = 'rea-workbench';

    const API = {
      status: '/api/dsh-plugin-rea/status',
      health: '/api/dsh-plugin-rea/health',
      metrics: '/api/dsh-plugin-rea/metrics',
      events: '/api/dsh-plugin-rea/events',
      metricsReset: '/api/dsh-plugin-rea/metrics/reset',
      mcpStart: '/api/dsh-plugin-rea/mcp/start',
      update: '/api/dsh-plugin-rea/update',
      selfUpdate: '/api/dsh-plugin-rea/self-update',
      jdk: '/api/dsh-plugin-rea/jdk',
      jdkInstall: '/api/dsh-plugin-rea/jdk/install',
      jdkUninstall: '/api/dsh-plugin-rea/jdk/uninstall',
      pythonPackages: '/api/dsh-plugin-rea/python/packages',
      pythonInstall: '/api/dsh-plugin-rea/python/install',
      pythonJob: '/api/dsh-plugin-rea/python/job',
      pythonControl: '/api/dsh-plugin-rea/python/control',
      install: '/api/dsh-plugin-rea/install',
      job: '/api/dsh-plugin-rea/job',
      control: '/api/dsh-plugin-rea/control',
      cancel: '/api/dsh-plugin-rea/cancel',
      uninstallPreview: '/api/dsh-plugin-rea/uninstall-preview',
      uninstall: '/api/dsh-plugin-rea/uninstall',
    };

    /** Poll cadence while a job runs. */
    const POLL_MS = 400;

    /** Health re-poll cadence; slow because it re-probes engines on disk. */
    const HEALTH_POLL_MS = 8000;

    /** Metrics refresh cadence while a stream is open. */
    const METRICS_POLL_MS = 3000;

    /** Rows the panel keeps for the stream view. */
    const STREAM_LIMIT = 200;

    /** Health status → dot class and label. */
    const STATUS_UI = {
      ok: { dot: 'hdot-ok', label: '正常' },
      warn: { dot: 'hdot-warn', label: '注意' },
      error: { dot: 'hdot-err', label: '异常' },
    };

    /** Per-engine presentation, static so cards render before status arrives. */
    /**
     * Chinese names for the tools that show up in the usage list.
     *
     * A tool id is an API name, not a word: `win_bash` is "run a command" and
     * `glob` is "find files by name". The panel is for people, so it says what
     * the tool does and keeps the id as a muted second line.
     */
    const TOOL_LABELS = {
      win_bash: '执行命令',
      read: '读文件',
      write: '写文件',
      edit: '修改文件',
      glob: '按名找文件',
      grep: '搜文件内容',
      present: '展示文件',
      todo_write: '写任务清单',
      web_fetch: '抓取网页',
      web_search: '网页搜索',
      ask_user_question: '向用户提问',
      create_skill: '创建技能',
      skill: '加载技能',
      skill_vault: '技能库',
      plugin_manager: '插件管理',
      mcp_vault: 'MCP 配置',
      subagent: '派子任务',
      subagent_fork: '派子任务（带上下文）',
      workflow: '多智能体流程',
      schedule_create: '建定时任务',
      schedule_list: '查看定时任务',
      schedule_delete: '删定时任务',
      schedule_update: '改定时任务',
      interrupt_agent: '中断子任务',
      send_message: '给子任务发消息',
      list_agents: '查看子任务',
      read_image: '看图',
      read_mcp_resource: '读 MCP 资源',
      list_mcp_resources: '列 MCP 资源',
      load_workspace_dependencies: '加载工作区依赖',
      working_directory: '切换工作目录',
      cordis_inspect_list: '查看插件接口',
      cordis_inspect_query: '查询插件状态',
      job_output: '取后台任务结果',
      job_list: '看后台任务',
      job_kill: '停后台任务',
      create_goal: '设长期目标',
      get_goal: '查看目标',
      update_goal: '更新目标',
      exit_plan_mode: '退出计划模式',
      config_backup: '备份配置',
      config_restore: '恢复配置',
      config_list_snapshots: '查看配置快照',
      mobile_unpack: '脱壳',
      mobile_frida: 'Frida 插桩',
      mobile_check: '反注入检测',
      mobile_so: 'SO 分析',
      mobile_emulate: '指令模拟',
      mobile_reference: '移动端手册',
      rea_cli: 'REA 命令行',
      rea_docs: 'REA 文档',
      rea_unpack: '脱壳流水线',
      rea_unpack_capabilities: '脱壳能力清单',
      rea_provider_status: '引擎状态',
      rea_provider_install: '安装引擎',
      rea_capability_matrix: '能力矩阵',
    };

    const ENGINES = {
      ghidra: {
        label: 'Ghidra',
        tagline: '原生二进制反编译、交叉引用、值流分析。Windows 上唯一的 native 引擎。',
        role: 'Windows 上唯一的 native 引擎',
        homepage: 'https://github.com/NationalSecurityAgency/ghidra/releases',
      },
      jadx: {
        label: 'JADX',
        tagline: 'APK / DEX 反编译为 Java 源码，Android 分析主力。',
        role: 'Android 反编译',
        homepage: 'https://github.com/skylot/jadx/releases',
      },
      apktool: {
        label: 'apktool',
        tagline: '资源解码、清单还原、smali 反汇编与重打包。',
        role: 'Android 资源与 smali',
        homepage: 'https://apktool.org/',
      },
      frida: {
        label: 'Frida',
        tagline: '动态插桩、运行时 Hook、内存扫描。通过全局 npm 安装。',
        role: '动态插桩',
        homepage: 'https://frida.re/',
      },
    };

    /** Human phase labels for a running job. */
    const PHASE_LABEL = {
      pending: '排队中',
      download: '下载',
      verify: '校验',
      extract: '解压',
      done: '完成',
      error: '失败',
      paused: '已暂停',
      cancelled: '已取消',
    };

    function formatBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB'];
      let value = bytes;
      let unit = 0;
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
      }
      return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
    }

    function formatSpeed(bytesPerSecond) {
      if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '';
      return `${formatBytes(bytesPerSecond)}/s`;
    }

    /** Time as HH:MM:SS for the stream column. */
    function formatClock(at) {
      const date = new Date(at);
      if (Number.isNaN(date.getTime())) return '—';
      const pad = (value) => String(value).padStart(2, '0');
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }

    function formatDuration(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
      if (ms < 1000) return `${Math.round(ms)}ms`;
      if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
      return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
    }

    /** Compact duration for KPI tiles: 1.2s / 340ms / 2m4s. */
    /**
     * Compact duration for KPI tiles: 1.2s / 340ms / 2m4s.
     *
     * Always an object, never a bare string: callers read `.value` and `.unit`,
     * and a string return produced `undefined` twice in the header before this
     * was fixed.
     */
    function formatShortDuration(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) {
        return { value: '—', unit: '' };
      }
      if (ms < 1000) return { value: String(Math.round(ms)), unit: 'ms' };
      if (ms < 60_000) return { value: (ms / 1000).toFixed(1), unit: 's' };
      return {
        value: String(Math.floor(ms / 60_000)),
        unit: `m${Math.round((ms % 60_000) / 1000)}s`,
      };
    }

    // -----------------------------------------------------------------------
    // Styles
    //
    // One hand-written sheet. No UI library: this panel ships inside a plugin
    // bundle, and a component library would cost more bytes than the whole
    // workbench. Tokens are local so the panel keeps its identity while still
    // reading the Host's semantic colours for anything it must match.
    // -----------------------------------------------------------------------
    function Styles() {
      return h('style', null, `
        /* finesse · register=product · A=teal+cool-slate · B=sans+mono
         * C=topnav+console · D=css-only · E=two-tone-shell
         * SOUL=5 SPECTACLE=2 DENSITY=8 */

        .rea-wb{
          --s50:#f6f7f9; --s100:#eceff3; --s200:#dde2e9; --s300:#c4ccd8;
          --s400:#97a2b3; --s500:#6f7c91; --s600:#566175; --s700:#454e5e;
          --s800:#333a46; --s900:#23272f; --s950:#14171c;

          --accent:#176C6B; --accent-2:#2FD3C5;
          --accent-soft:rgba(23,108,107,.10);
          --on-accent:#f7fcfc;

          --page:var(--s100); --bg:#fcfdfe; --panel-2:var(--s50);
          --border:rgba(35,39,47,.07); --border-2:rgba(35,39,47,.14);
          --ink-1:var(--s950); --ink-2:var(--s700); --ink-3:var(--s500);
          --ink-4:var(--s400);

          --up:#3E7A52; --down:#C22E22; --warn:#B77A16;
          --up-soft:rgba(62,122,82,.11); --down-soft:rgba(194,46,34,.10);
          --warn-soft:rgba(183,122,22,.12);

          --rail:#14171c; --rail-2:#1c2027; --rail-3:#262b34;
          --rail-ink:#8b97a8; --rail-ink-2:#5d6878; --rail-ink-on:#f2f5f9;
          --rail-border:rgba(255,255,255,.07);

          --shadow:0 1px 3px rgba(20,23,28,.05);

          --r:14px; --r-sm:10px; --r-xs:7px;
          --sans:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,'PingFang SC','Microsoft YaHei',sans-serif;
          --mono:ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace;

          display:flex; flex-direction:column;
          height:100%; min-height:0; overflow:hidden;
          background:var(--page); color:var(--ink-1);
          font-family:var(--sans); font-size:13px; line-height:1.5;
          -webkit-font-smoothing:antialiased;
        }
        .rea-wb *{box-sizing:border-box}
        .rea-wb button{font:inherit;color:inherit;border:0;background:none;cursor:pointer}
        .rea-wb .num{font-family:var(--mono);font-variant-numeric:tabular-nums}
        .rea-wb :focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}

        /* ── top navigation ─────────────────────────────────── */
        .rea-topnav{
          flex:none;display:flex;align-items:center;gap:2px;
          height:52px;padding:0 14px 0 16px;
          background:var(--rail);color:var(--rail-ink);
          border-bottom:1px solid var(--rail-border);
          overflow-x:auto;overflow-y:hidden;
        }
        .rea-topnav::-webkit-scrollbar{height:0}
        .rea-brand{
          display:flex;align-items:center;gap:9px;flex:none;
          padding-right:14px;margin-right:6px;height:24px;
          border-right:1px solid var(--rail-border);
        }
        .rea-mk{
          width:26px;height:26px;border-radius:8px;flex:none;display:grid;place-items:center;
          background:var(--accent);color:var(--on-accent);
          font-weight:800;font-size:10.5px;letter-spacing:-.03em;
        }
        .rea-brand b{
          color:var(--rail-ink-on);font-size:13.5px;font-weight:800;
          letter-spacing:-.01em;white-space:nowrap;
        }
        .rea-pulse{
          width:6px;height:6px;border-radius:50%;background:var(--up);flex:none;
          box-shadow:0 0 0 3px rgba(62,122,82,.22);
          animation:rea-pl 2.4s ease-in-out infinite;
        }
        .rea-pulse-down{background:var(--down);box-shadow:0 0 0 3px var(--down-soft)}
        @keyframes rea-pl{0%,100%{opacity:1}50%{opacity:.4}}

        .rea-tabs{display:flex;align-items:center;gap:2px;flex:none}
        .rea-tab{
          position:relative;display:flex;align-items:center;gap:6px;
          padding:6px 11px;border-radius:7px;
          color:#9aa6b6;font-size:12.5px;font-weight:500;white-space:nowrap;
          transition:background .16s ease,color .16s ease;
        }
        .rea-tab:hover{background:var(--rail-2);color:var(--rail-ink-on)}
        .rea-tab svg{width:14px;height:14px;flex:none;opacity:.7}
        .rea-tab-on{background:var(--rail-3);color:var(--rail-ink-on);font-weight:600}
        .rea-tab-on svg{opacity:1;color:var(--accent-2)}
        .rea-tab-bdg{
          font-family:var(--mono);font-size:9px;font-weight:700;
          min-width:15px;text-align:center;padding:0 4px;border-radius:99px;
          background:var(--rail-3);color:var(--rail-ink);line-height:15px;height:15px;
        }
        .rea-tab-on .rea-tab-bdg{background:rgba(255,255,255,.13)}
        .rea-tab-bdg-err{background:rgba(194,46,34,.26);color:#ff9587}
        .rea-tab-bdg-warn{background:rgba(183,122,22,.26);color:#e8b45e}

        .rea-tb-right{
          margin-left:auto;display:flex;align-items:center;gap:10px;flex:none;
          padding-left:12px;
        }
        .rea-stat{font-size:11.5px;color:var(--rail-ink-2);white-space:nowrap;line-height:1}
        .rea-stat b{color:#e8edf4;font-weight:700;margin-left:4px;font-size:12px}
        .rea-stat b.down{color:#ff9587}
        .rea-tb-div{width:1px;height:16px;background:var(--rail-border)}

        /* ── buttons ────────────────────────────────────────── */
        .rea-btn{
          display:inline-flex;align-items:center;gap:6px;
          padding:6px 11px;border-radius:var(--r-xs);
          font-size:12px;font-weight:600;white-space:nowrap;
          border:1px solid var(--border-2);background:var(--bg);color:var(--ink-2);
          transition:background .15s ease,border-color .15s ease,color .15s ease;
        }
        .rea-btn:hover{background:var(--panel-2);border-color:var(--ink-4);color:var(--ink-1)}
        .rea-btn svg{width:13px;height:13px}
        .rea-btn:disabled{opacity:.45;cursor:not-allowed;pointer-events:none}
        .rea-btn-primary{
          background:var(--accent);border-color:var(--accent);color:var(--on-accent);
          box-shadow:0 1px 2px rgba(23,108,107,.22);
        }
        .rea-btn-primary:hover{background:#12544f;border-color:#12544f;color:var(--on-accent)}
        .rea-btn-ghost{border-color:transparent;background:none}
        /* The update button states. accent marks "there is something to pull",
           danger marks a failed pull — both are tinted outlines rather than
           filled buttons so they never compete with the primary 引擎 action. */
        .rea-btn-accent{
          border-color:rgba(23,108,107,.42);background:var(--accent-soft);color:var(--accent);
        }
        .rea-btn-accent:hover{
          background:var(--accent-soft);border-color:var(--accent);color:var(--accent);
        }
        .rea-btn-danger{border-color:rgba(196,74,74,.42);color:var(--down)}
        .rea-btn-danger:hover{
          border-color:var(--down);color:var(--down);background:var(--panel-2);
        }
        .rea-btn-sm{padding:4px 8px;font-size:11px}
        .rea-btn-sm svg{width:12px;height:12px}
        /* An anchor styled as a button must not inherit link decoration, and a
           square icon-only variant needs its padding balanced on both axes. */
        .rea-btn-icon{text-decoration:none;cursor:pointer}
        .rea-btn-icon svg{width:14px;height:14px}
        /* buttons on the dark bar invert for contrast */
        .rea-topnav .rea-btn{border-color:rgba(255,255,255,.13);background:transparent;color:var(--rail-ink)}
        .rea-topnav .rea-btn:hover{background:var(--rail-2);border-color:rgba(255,255,255,.22);color:var(--rail-ink-on)}
        .rea-topnav .rea-btn-primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
        .rea-topnav .rea-btn-primary:hover{background:#12544f;border-color:#12544f}

        /* ── scroll surface ─────────────────────────────────── */
        .rea-scroll{
          flex:1;min-height:0;overflow-y:auto;padding:16px 20px 28px;
        }
        .rea-scroll::-webkit-scrollbar{width:8px}
        .rea-scroll::-webkit-scrollbar-thumb{
          background:var(--s300);border-radius:99px;border:2px solid var(--page);
        }

        /* ── card ───────────────────────────────────────────── */
        .rea-card{
          background:var(--bg);border:1px solid var(--border);
          border-radius:var(--r);box-shadow:var(--shadow);min-width:0;
        }
        .rea-card-hd{
          display:flex;align-items:center;gap:8px;
          padding:12px 15px;border-bottom:1px solid var(--border);
        }
        .rea-card-hd h3{font-size:12.5px;font-weight:700;letter-spacing:-.01em;flex:none}
        .rea-card-hd .sub{
          font-size:11px;color:var(--ink-3);margin-left:auto;font-family:var(--mono);
        }
        .rea-card-bd{padding:15px}

        .rea-sec-label{
          font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;
          color:var(--ink-4);margin-bottom:8px;
        }

        /* ── KPI row ────────────────────────────────────────── */
        .rea-kpis{
          display:grid;grid-template-columns:repeat(4,minmax(0,1fr)) minmax(0,1.35fr);
          gap:11px;margin-bottom:13px;
        }
        .rea-kpi{
          background:var(--bg);border:1px solid var(--border);border-radius:var(--r);
          padding:12px 14px 13px;box-shadow:var(--shadow);min-width:0;
          display:flex;flex-direction:column;gap:5px;
          transition:border-color .16s ease;
        }
        .rea-kpi:hover{border-color:var(--border-2)}
        .rea-kpi-click{transition:border-color .16s ease,box-shadow .16s ease}
        .rea-kpi-click:hover{
          border-color:var(--accent);
          box-shadow:0 4px 14px -6px rgba(23,108,107,.28);
        }
        .rea-kpi-top{display:flex;align-items:center;gap:8px}
        .rea-chip{
          width:28px;height:28px;border-radius:8px;flex:none;
          display:grid;place-items:center;
          background:var(--panel-2);color:var(--ink-3);
        }
        .rea-chip svg{width:14px;height:14px}
        .rea-chip-accent{background:var(--accent-soft);color:var(--accent)}
        .rea-chip-up{background:var(--up-soft);color:var(--up)}
        .rea-chip-warn{background:var(--warn-soft);color:var(--warn)}
        .rea-kpi-delta{
          margin-left:auto;font-size:10.5px;font-weight:700;font-family:var(--mono);
          padding:1px 6px;border-radius:99px;
          background:var(--panel-2);color:var(--ink-3);white-space:nowrap;
        }
        .rea-kpi-delta-up{background:var(--up-soft);color:var(--up)}
        .rea-kpi-delta-down{background:var(--down-soft);color:var(--down)}
        .rea-kpi-label{font-size:11px;color:var(--ink-3);font-weight:500}
        .rea-kpi-value{
          font-size:23px;font-weight:800;letter-spacing:-.025em;line-height:1.1;
          font-variant-numeric:tabular-nums;
        }
        .rea-kpi-value small{font-size:12px;font-weight:600;color:var(--ink-3);margin-left:3px}
        .rea-kpi-foot{font-size:10.5px;color:var(--ink-4);line-height:1.4}

        /* the one card allowed a glow: the primary metric */
        .rea-kpi-hero{
          background:linear-gradient(152deg,var(--accent) 0%,#0f4f4e 100%);
          border-color:transparent;color:var(--on-accent);
          position:relative;overflow:hidden;
        }
        .rea-kpi-hero::after{
          content:'';position:absolute;right:-40px;top:-40px;
          width:130px;height:130px;border-radius:50%;
          background:rgba(47,211,197,.16);pointer-events:none;
        }
        .rea-kpi-hero .rea-chip{background:rgba(255,255,255,.16);color:var(--on-accent)}
        .rea-kpi-hero .rea-kpi-label{color:rgba(255,255,255,.72)}
        .rea-kpi-hero .rea-kpi-value{color:var(--on-accent)}
        .rea-kpi-hero .rea-kpi-value small{color:rgba(255,255,255,.6)}
        .rea-kpi-hero .rea-kpi-foot{color:rgba(255,255,255,.55)}
        .rea-kpi-hero .rea-kpi-delta{background:rgba(255,255,255,.18);color:#f7fcfc}
        .rea-spark{position:relative;z-index:1;height:26px;margin-top:2px}

        /* ── layout grids ───────────────────────────────────── */
        .rea-cols-2{
          display:grid;grid-template-columns:minmax(0,1.28fr) minmax(0,1fr);
          gap:13px;align-items:start;
        }
        .rea-cols-3{
          display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:13px;
        }
        .rea-stack{display:flex;flex-direction:column;gap:13px}

        /* ── rank list ──────────────────────────────────────── */
        .rea-rank{display:flex;flex-direction:column;gap:2px}
        .rea-rank-row{
          display:grid;
          grid-template-columns:15px minmax(0,1fr) minmax(70px,140px) 34px;
          gap:10px;align-items:center;padding:7px;
          border-radius:var(--r-xs);
          transition:background .14s ease;
        }
        .rea-rank-row:hover{background:var(--panel-2)}
        .rea-rank-i{
          font-family:var(--mono);font-size:10px;font-weight:700;
          color:var(--ink-4);text-align:center;
        }
        .rea-rank-name{
          font-family:var(--mono);font-size:11.5px;color:var(--ink-1);
          overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
        }
        .rea-rank-track{
          display:block;height:6px;border-radius:3px;
          background:var(--panel-2);overflow:hidden;
        }
        .rea-rank-bar{
          display:block;height:100%;border-radius:3px;
          background:linear-gradient(90deg,var(--accent),var(--accent-2));
        }
        .rea-rank-n{
          font-family:var(--mono);font-size:11.5px;font-weight:700;
          color:var(--ink-1);text-align:right;font-variant-numeric:tabular-nums;
        }
        .rea-rank-n.down{color:var(--down)}
        .rea-rank-n.warn{color:var(--warn)}

        /* ── alert list ─────────────────────────────────────── */
        .rea-alerts{display:flex;flex-direction:column}
        .rea-alert{
          display:flex;gap:10px;padding:9px 4px;
          border-bottom:1px solid var(--border);
        }
        .rea-alert:last-child{border-bottom:0}
        .rea-alert-dot{width:6px;height:6px;border-radius:50%;flex:none;margin-top:6px}
        .rea-alert-body{min-width:0;flex:1;display:flex;flex-direction:column;gap:2px}
        .rea-alert-msg{font-size:11.5px;color:var(--ink-1);line-height:1.45;word-break:break-word}
        .rea-alert-meta{
          font-size:10.5px;color:var(--ink-4);font-family:var(--mono);
          display:flex;gap:7px;flex-wrap:wrap;
        }

        /* ── quick actions ──────────────────────────────────── */
        .rea-quick{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:11px}
        .rea-qbtn{
          display:flex;flex-direction:column;align-items:flex-start;gap:8px;
          padding:15px 16px;min-height:104px;border-radius:var(--r);
          border:1px solid var(--border);background:var(--bg);text-align:left;
          /* A shortcut that does not advertise itself is a decoration. */
          cursor:pointer;
          transition:border-color .16s ease,box-shadow .16s ease,transform .16s ease;
        }
        .rea-qbtn:hover{
          border-color:var(--accent);
          box-shadow:0 4px 14px -6px rgba(23,108,107,.28);
          transform:translateY(-1px);
        }
        .rea-qbtn:active{transform:translateY(0)}
        .rea-qbtn b{font-size:12px;font-weight:700}
        .rea-qbtn small{font-size:10.5px;color:var(--ink-4);line-height:1.4}

        /* ── stream ─────────────────────────────────────────── */
        .rea-stream-pane{
          display:grid;grid-template-columns:minmax(0,1fr) 400px;
          gap:13px;align-items:start;
        }
        .rea-filters{
          display:flex;align-items:center;gap:7px;flex-wrap:wrap;
          padding:9px 13px;border-bottom:1px solid var(--border);
          background:var(--panel-2);
        }
        .rea-pill{
          padding:3.5px 9px;border-radius:99px;font-size:11px;font-weight:600;
          border:1px solid transparent;color:var(--ink-3);
          transition:background .14s ease,color .14s ease,border-color .14s ease,box-shadow .14s ease;
        }
        .rea-pill:hover{color:var(--ink-1)}
        .rea-pill-on{
          background:var(--bg);color:var(--ink-1);
          border-color:var(--border-2);box-shadow:var(--shadow);
        }
        .rea-pill-on-accent{background:var(--accent-soft);color:var(--accent);border-color:transparent}
        .rea-search{
          flex:1;min-width:110px;display:flex;align-items:center;gap:6px;
          padding:4px 9px;border-radius:var(--r-xs);
          border:1px solid var(--border);background:var(--bg);
        }
        .rea-search svg{width:12px;height:12px;color:var(--ink-4);flex:none}
        .rea-search input{
          border:0;background:none;outline:none;font:inherit;font-size:11.5px;
          color:var(--ink-1);width:100%;min-width:0;
        }
        .rea-search input::placeholder{color:var(--ink-4)}

        .rea-rows{display:flex;flex-direction:column;max-height:520px;overflow-y:auto}
        .rea-rows::-webkit-scrollbar{width:7px}
        .rea-rows::-webkit-scrollbar-thumb{background:var(--s300);border-radius:99px}
        .rea-row{
          display:grid;grid-template-columns:60px minmax(0,1fr) 56px 42px;
          gap:12px;align-items:center;padding:8px 14px;
          border-bottom:1px solid var(--border);
          cursor:pointer;transition:background .13s ease;font-size:11.5px;
        }
        .rea-row:hover{background:var(--panel-2)}
        .rea-row:last-child{border-bottom:0}
        .rea-row-on{background:var(--accent-soft)!important;box-shadow:inset 2px 0 0 var(--accent)}
        .rea-row-t{font-family:var(--mono);font-size:10.5px;color:var(--ink-4)}
        .rea-row-name{
          font-family:var(--mono);font-size:11.5px;color:var(--ink-1);
          overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
        }
        .rea-row-ms{
          font-family:var(--mono);font-size:10.5px;color:var(--ink-3);
          text-align:right;font-variant-numeric:tabular-nums;
        }
        .rea-row-ms-slow{color:var(--warn);font-weight:700}
        .rea-tag{
          font-size:9px;font-weight:800;letter-spacing:.04em;
          padding:1.5px 5px;border-radius:4px;text-align:center;font-family:var(--mono);
        }
        .rea-tag-ok{background:var(--up-soft);color:var(--up)}
        .rea-tag-fail{background:var(--down-soft);color:var(--down)}
        .rea-tag-slow{background:var(--warn-soft);color:var(--warn)}
        .rea-tag-mute{background:var(--panel-2);color:var(--ink-3)}

        /* ── detail aside ───────────────────────────────────── */
        .rea-detail{position:sticky;top:0}
        .rea-d-hd{padding:12px 14px;border-bottom:1px solid var(--border)}
        .rea-d-name{
          font-family:var(--mono);font-size:12px;font-weight:700;
          word-break:break-all;line-height:1.4;
        }
        .rea-d-meta{display:flex;gap:6px;flex-wrap:wrap;margin-top:7px}
        .rea-d-kv{
          display:grid;grid-template-columns:auto 1fr;gap:5px 10px;
          padding:11px 14px;font-size:11px;border-bottom:1px solid var(--border);
        }
        .rea-d-kv dt{color:var(--ink-3)}
        .rea-d-kv dd{
          font-family:var(--mono);color:var(--ink-1);
          text-align:right;word-break:break-all;margin:0;
        }
        .rea-d-sec{padding:11px 14px;border-bottom:1px solid var(--border)}
        .rea-d-sec:last-child{border-bottom:0}
        .rea-d-sec h4{
          font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;
          color:var(--ink-4);margin-bottom:7px;
        }
        .rea-code{
          font-family:var(--mono);font-size:10.5px;line-height:1.62;
          background:var(--panel-2);border:1px solid var(--border);
          border-radius:var(--r-xs);padding:9px 10px;
          overflow:auto;color:var(--ink-2);max-height:170px;
          white-space:pre;tab-size:2;margin:0;
        }
        .rea-code::-webkit-scrollbar{width:6px;height:6px}
        .rea-code::-webkit-scrollbar-thumb{background:var(--s300);border-radius:99px}
        .rea-tok-k{color:var(--accent);font-weight:600}
        .rea-tok-s{color:var(--up)}
        .rea-tok-n{color:#8a5a12}
        .rea-tok-c{color:var(--ink-4);font-style:italic}

        .rea-evidence{display:flex;align-items:center;gap:7px;font-size:11px}
        .rea-evidence-off{opacity:.45}

        /* ── empty state ────────────────────────────────────── */
        .rea-empty{
          display:flex;flex-direction:column;align-items:center;justify-content:center;
          gap:9px;padding:44px 20px;text-align:center;
        }
        .rea-empty-ic{
          width:38px;height:38px;border-radius:11px;display:grid;place-items:center;
          background:var(--panel-2);color:var(--ink-4);
        }
        .rea-empty-ic svg{width:18px;height:18px}
        .rea-empty b{font-size:12.5px;font-weight:700;color:var(--ink-2)}
        .rea-empty p{
          font-size:11.5px;color:var(--ink-4);line-height:1.55;max-width:280px;
        }

        /* ── health rows ────────────────────────────────────── */
        .rea-hrow{
          display:flex;align-items:center;gap:11px;
          padding:10px 14px;border-bottom:1px solid var(--border);
        }
        .rea-hrow:last-child{border-bottom:0}
        .rea-hdot{width:7px;height:7px;border-radius:50%;flex:none}
        .rea-hdot-ok{background:var(--up);box-shadow:0 0 0 3px var(--up-soft)}
        .rea-hdot-warn{background:var(--warn);box-shadow:0 0 0 3px var(--warn-soft)}
        .rea-hdot-err{
          background:var(--down);box-shadow:0 0 0 3px var(--down-soft);
          animation:rea-pl 2s ease-in-out infinite;
        }
        .rea-hbody{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
        .rea-hlabel{font-size:12px;font-weight:600}
        .rea-hdetail{font-size:10.5px;color:var(--ink-3);line-height:1.45}
        .rea-hfix{font-size:10.5px;color:var(--warn);margin-top:2px;line-height:1.45}
        .rea-hval{
          font-family:var(--mono);font-size:10.5px;color:var(--ink-3);
          max-width:210px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
          text-align:right;flex:none;
        }

        /* ── engine cards ───────────────────────────────────── */
        .rea-engines{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:11px}
        .rea-eng{
          border:1px solid var(--border);border-radius:var(--r);background:var(--bg);
          padding:13px 14px;display:flex;flex-direction:column;gap:9px;
          box-shadow:var(--shadow);min-width:0;overflow:hidden;
          transition:border-color .16s ease;
        }
        .rea-eng:hover{border-color:var(--border-2)}
        .rea-eng-hd{display:flex;align-items:center;gap:8px}
        .rea-eng-hd b{font-size:12.5px;font-weight:700}
        .rea-eng-tag{
          margin-left:auto;font-size:9.5px;font-weight:700;font-family:var(--mono);
          padding:1.5px 6px;border-radius:99px;white-space:nowrap;
        }
        .rea-eng-tag-on{background:var(--up-soft);color:var(--up)}
        .rea-eng-tag-off{background:var(--warn-soft);color:var(--warn)}
        .rea-eng-tag-busy{background:var(--accent-soft);color:var(--accent)}
        .rea-eng p{font-size:10.5px;color:var(--ink-3);line-height:1.5;min-height:31px;margin:0}
        .rea-prog{height:3px;width:100%;border-radius:2px;background:var(--panel-2);overflow:hidden;flex:none}
        .rea-prog i{display:block;height:100%;background:var(--accent);border-radius:2px;transition:width .3s ease}
        .rea-prog-meta{
          display:flex;justify-content:space-between;gap:8px;
          font-family:var(--mono);font-size:9.5px;color:var(--ink-4);
        }
        .rea-eng-foot{display:flex;gap:6px;align-items:center;margin-top:auto;padding-top:2px}
        .rea-eng-note{font-size:10.5px;color:var(--ink-4);margin-left:auto;align-self:center}

        /* ── targets ────────────────────────────────────────── */
        .rea-targets{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}
        .rea-tgt{
          display:flex;flex-direction:column;gap:5px;padding:11px 13px;
          border:1px solid var(--border);border-radius:var(--r-sm);
          background:var(--bg);box-shadow:var(--shadow);min-width:0;
        }
        .rea-tgt-blocked{border-style:dashed;background:var(--panel-2);box-shadow:none}
        .rea-tgt-hd{display:flex;align-items:center;gap:7px}
        .rea-tgt-hd b{font-size:12px;font-weight:700}
        .rea-tgt-dot{width:6px;height:6px;border-radius:50%;flex:none}
        .rea-tgt-engine{
          margin-left:auto;font-family:var(--mono);font-size:9.5px;font-weight:600;
          padding:1px 6px;border-radius:99px;white-space:nowrap;
          background:var(--accent-soft);color:var(--accent);
        }
        .rea-tgt-engine-off{background:var(--panel-2);color:var(--ink-4)}
        .rea-tgt-fmt{font-family:var(--mono);font-size:10px;color:var(--ink-3);padding-left:13px}
        .rea-tgt-tool{
          font-size:10px;color:var(--ink-4);padding-left:13px;line-height:1.4;
          overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
        }
        .rea-tgt-head{
          display:flex;align-items:center;justify-content:space-between;margin:16px 0 9px;
        }
        .rea-tgt-head b{font-size:16px;font-weight:800;font-variant-numeric:tabular-nums}
        .rea-tgt-note{font-size:11px;color:var(--ink-4);margin-left:6px}
        .rea-cat-row{
          display:flex;align-items:center;justify-content:space-between;
          padding:4px 0;font-size:11.5px;color:var(--ink-2);
          border-bottom:1px solid var(--border);
        }
        .rea-cat-row:last-child{border-bottom:0}
        .rea-cat-row b{font-weight:700;color:var(--ink-1)}

        /* ── error groups ───────────────────────────────────── */
        .rea-egrp{
          display:flex;gap:12px;padding:12px 14px;margin-bottom:9px;
          border:1px solid var(--border-2);border-radius:var(--r);
          background:linear-gradient(180deg,var(--down-soft),transparent 46%),var(--bg);
          box-shadow:var(--shadow);
        }
        .rea-egrp-warn{
          background:linear-gradient(180deg,var(--warn-soft),transparent 46%),var(--bg);
        }
        .rea-egrp-n{
          font-family:var(--mono);font-size:17px;font-weight:800;color:var(--down);
          min-width:26px;text-align:center;line-height:1.15;
        }
        .rea-egrp-warn .rea-egrp-n{color:var(--warn)}
        .rea-egrp-n small{
          display:block;font-size:8.5px;font-weight:600;
          color:var(--ink-4);letter-spacing:.06em;
        }
        .rea-egrp-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
        .rea-egrp-tool{font-family:var(--mono);font-size:11px;font-weight:700}
        .rea-egrp-msg{
  font-size:11.5px;color:var(--ink-2);line-height:1.5;word-break:break-word;
  display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;
  overflow:hidden;cursor:pointer;
}
.rea-egrp-msg-open{
  display:block;-webkit-line-clamp:unset;
  font-family:var(--mono);font-size:10.5px;
  background:var(--panel-2);border:1px solid var(--border);
  border-radius:var(--r-xs);padding:8px 10px;margin-top:3px;
  max-height:220px;overflow:auto;white-space:pre-wrap;
}
        .rea-egrp-meta{font-size:10px;color:var(--ink-4);font-family:var(--mono)}

        /* ── chart ──────────────────────────────────────────── */
        .rea-chart{
          display:flex;align-items:flex-end;gap:9px;height:68px;
          border-bottom:1px solid var(--border-2);
        }
        .rea-chart-col{
          flex:1;display:flex;flex-direction:column;align-items:center;
          justify-content:flex-end;height:100%;gap:3px;min-width:0;
        }
        .rea-chart-n{
          font-family:var(--mono);font-size:9.5px;font-weight:700;color:var(--ink-2);
        }
        .rea-chart-bar{
          width:100%;max-width:38px;border-radius:3px 3px 0 0;
          background:var(--panel-2);
        }
        .rea-chart-axis{display:flex;gap:9px;margin-top:5px}
        .rea-chart-axis span{
          flex:1;text-align:center;font-size:9.5px;color:var(--ink-4);
          font-family:var(--mono);min-width:0;
        }

        /* ── log ────────────────────────────────────────────── */
        .rea-log{
          font-family:var(--mono);font-size:10.5px;line-height:1.6;
          background:var(--panel-2);border:1px solid var(--border);
          border-radius:var(--r-sm);padding:10px 12px;margin:0;
          white-space:pre-wrap;word-break:break-word;
          color:var(--ink-2);max-height:200px;overflow:auto;
        }
        .rea-log-err{
          border-color:rgba(194,46,34,.28);
          background:rgba(194,46,34,.05);color:#8f2216;
        }

        /* ── banner (blocking state the user can act on) ────── */
        .rea-banner{
          display:flex;align-items:center;gap:11px;
          padding:11px 14px;margin-bottom:13px;
          border:1px solid rgba(183,122,22,.28);
          border-radius:var(--r);background:var(--warn-soft);
        }
        .rea-banner-title{font-size:12.5px;font-weight:700;color:var(--ink-1)}
        .rea-banner-body{
          font-size:11px;color:var(--ink-2);line-height:1.5;
          margin-top:2px;word-break:break-word;
          font-family:var(--mono);
        }

        /* ── hint ───────────────────────────────────────────── */
        .rea-hint{
          display:flex;gap:9px;align-items:flex-start;
          padding:10px 13px;border-radius:var(--r-sm);margin-bottom:13px;
          border:1px solid rgba(23,108,107,.2);background:var(--accent-soft);
          font-size:11.5px;color:var(--ink-2);line-height:1.55;
        }
        .rea-hint code{
          font-family:var(--mono);font-size:10.5px;
          background:rgba(0,0,0,.05);padding:1px 4px;border-radius:3px;
        }

        /* ── responsive ─────────────────────────────────────── */
        @media (max-width:1180px){
          .rea-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}
          .rea-kpi-hero{grid-column:span 2}
          .rea-cols-2,.rea-stream-pane{grid-template-columns:minmax(0,1fr)}
          .rea-detail{position:static}
          .rea-stat-hide{display:none}
        }
        @media (max-width:860px){
          .rea-cols-3,.rea-quick,.rea-engines,.rea-targets{
            grid-template-columns:minmax(0,1fr);
          }
          .rea-tab{padding:6px 8px}
          .rea-tab-label{display:none}
          .rea-tab svg{width:15px;height:15px}
          .rea-brand b{display:none}
          .rea-brand{padding-right:10px;margin-right:4px}
          .rea-scroll{padding:12px 12px 20px}
          .rea-row{grid-template-columns:52px minmax(0,1fr) 44px;font-size:11px}
          .rea-row .rea-tag-slow{display:none}
        }
        @media (max-width:640px){
          .rea-tb-right .rea-stat{display:none}
          .rea-tb-div{display:none}
          .rea-brand{padding-right:8px;margin-right:2px}
          .rea-kpis{grid-template-columns:minmax(0,1fr)}
          .rea-kpi-hero{grid-column:auto}
          .rea-topnav{padding:0 10px}
          .rea-scroll{padding:10px 10px 18px}
          .rea-kpi-value{font-size:20px}
          .rea-row{grid-template-columns:46px minmax(0,1fr) 38px;gap:8px;padding:8px 10px}
          .rea-row .rea-row-ms{display:none}
          .rea-stream-pane{gap:10px}
        }
        @media (max-width:420px){
          .rea-topnav .rea-btn-label{display:none}
          .rea-tab{padding:6px 7px}
          .rea-topnav{gap:0}
        }
        @media (prefers-reduced-motion:reduce){
          .rea-wb *{
            animation-duration:.01ms!important;
            transition-duration:.01ms!important;
          }
        }
      `);
    }

    // -----------------------------------------------------------------------
    // Icons
    // -----------------------------------------------------------------------
    const Icon = {
      grid: () => h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('rect', { x: 3, y: 3, width: 7, height: 9 }),
        h('rect', { x: 14, y: 3, width: 7, height: 5 }),
        h('rect', { x: 14, y: 12, width: 7, height: 9 }),
        h('rect', { x: 3, y: 16, width: 7, height: 5 })),
      wave: () => h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('path', { d: 'M22 12h-4l-3 9L9 3l-3 9H2' })),
      alert: () => h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('path', { d: 'M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z' }),
        h('line', { x1: 12, y1: 9, x2: 12, y2: 13 }),
        h('line', { x1: 12, y1: 17, x2: 12.01, y2: 17 })),
      wrench: () => h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('path', { d: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z' })),
      target: () => h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('circle', { cx: 12, cy: 12, r: 10 }),
        h('circle', { cx: 12, cy: 12, r: 6 }),
        h('circle', { cx: 12, cy: 12, r: 2 })),
      check: () => h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round' },
        h('polyline', { points: '20 6 9 17 4 12' })),
      chart: () => h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('path', { d: 'M3 3v18h18' }),
        h('path', { d: 'm19 9-5 5-4-4-3 3' })),
      search: () => h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round' },
        h('circle', { cx: 11, cy: 11, r: 8 }),
        h('line', { x1: 21, y1: 21, x2: 16.65, y2: 16.65 })),
      box: () => h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('path', { d: 'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z' }),
        h('polyline', { points: '3.27 6.96 12 12.01 20.73 6.96' }),
        h('line', { x1: 12, y1: 22.08, x2: 12, y2: 12 })),
      file: () => h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('path', { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' }),
        h('polyline', { points: '14 2 14 8 20 8' }),
        h('line', { x1: 16, y1: 13, x2: 8, y2: 13 }),
        h('line', { x1: 16, y1: 17, x2: 8, y2: 17 })),
      upload: () => h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round' },
        h('path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }),
        h('polyline', { points: '17 8 12 3 7 8' }),
        h('line', { x1: 12, y1: 3, x2: 12, y2: 15 })),
      /**
       * GitHub mark. Uses currentColor so it inherits the button's ink like every
       * other icon here, and scales with the shared 14px box.
       */
      github: () => h('svg', {
        width: 14, height: 14, viewBox: '0 0 16 16',
        fill: 'currentColor', 'aria-hidden': 'true',
      },
        h('path', {
          d: 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 '
            + '0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13'
            + '-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66'
            + '.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15'
            + '-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27'
            + '.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12'
            + '.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48'
            + ' 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8'
            + 'c0-4.42-3.58-8-8-8Z',
        })),

      refresh: () => h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round' },
        h('polyline', { points: '23 4 23 10 17 10' }),
        h('path', { d: 'M20.49 15a9 9 0 1 1-2.12-9.36L23 10' })),
      pause: () => h('svg', { viewBox: '0 0 24 24', fill: 'currentColor' },
        h('rect', { x: 6, y: 4, width: 4, height: 16 }),
        h('rect', { x: 14, y: 4, width: 4, height: 16 })),
      play: () => h('svg', { viewBox: '0 0 24 24', fill: 'currentColor' },
        h('polygon', { points: '6 4 20 12 6 20' })),
      trash: () => h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round' },
        h('polyline', { points: '3 6 5 6 21 6' }),
        h('path', { d: 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' })),
    };

    // -----------------------------------------------------------------------
    // Sidebar icon
    // -----------------------------------------------------------------------
    function SidebarIcon({ size = 20, active = false }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8,
        strokeLinecap: 'round', strokeLinejoin: 'round',
        style: { opacity: active ? 1 : 0.72 },
      },
        h('path', { d: 'M12 2.5 3.5 7v10L12 21.5 20.5 17V7L12 2.5z' }),
        h('path', { d: 'M12 12.6 8 10.2V6.4M12 12.6l4-2.4V6.4M12 12.6v5.9' }),
        h('circle', { cx: 12, cy: 12, r: 1.1, fill: 'currentColor', stroke: 'none' }));
    }

    // -----------------------------------------------------------------------
    // Small presentational pieces
    // -----------------------------------------------------------------------

    /** A KPI tile. `hero` is reserved for the one metric that leads the page. */
    function Kpi({ icon, iconClass, delta, deltaClass, label, value, unit, foot, hero, onClick }) {
      return h(onClick ? 'button' : 'div', {
        type: onClick ? 'button' : undefined,
        onClick,
        className: `rea-kpi${hero ? ' rea-kpi-hero' : ''}${onClick ? ' rea-kpi-click' : ''}`,
        style: onClick ? { textAlign: 'left', font: 'inherit', cursor: 'pointer' } : undefined,
      },
        h('div', { className: 'rea-kpi-top' },
          h('div', { className: `rea-chip${iconClass ? ` ${iconClass}` : ''}` }, icon()),
          delta ? h('span', { className: `rea-kpi-delta${deltaClass ? ` ${deltaClass}` : ''}` }, delta) : null),
        h('span', { className: 'rea-kpi-label' }, label),
        h('div', { className: 'rea-kpi-value' },
          value,
          unit ? h('small', null, unit) : null),
        foot ? h('span', { className: 'rea-kpi-foot' }, foot) : null,
      );
    }

    /** A ranked row: index, name, proportional bar, count. */
    /**
     * One ranked row.
     *
     * `name` is the Chinese label and `raw` is the tool id. Both are shown: the
     * label is what a non-programmer can act on, and the id underneath is what
     * they need when searching documentation or reporting a problem. The id
     * goes to the tooltip as well as a muted second line, so it is available
     * without competing with the label.
     */
    function RankRow({ index, name, raw, value, max, suffix, tone }) {
      const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
      return h('div', { className: 'rea-rank-row' },
        h('span', { className: 'rea-rank-i' }, index),
        h('span', {
          className: 'rea-rank-name',
          title: raw ? `${name}（${raw}）` : name,
          style: raw && raw !== name
            ? { display: 'flex', flexDirection: 'column', gap: '1px', lineHeight: '1.3' }
            : undefined,
        },
          h('span', { style: { fontSize: '11.5px', color: 'var(--ink-1)', fontWeight: 600 } }, name),
          raw && raw !== name
            ? h('span', {
                style: {
                  fontFamily: 'var(--mono)', fontSize: '9.5px',
                  color: 'var(--ink-4)', fontWeight: 400,
                },
              }, raw)
            : null),
        h('span', { className: 'rea-rank-track' },
          h('span', { className: 'rea-rank-bar', style: { width: `${pct}%` } })),
        h('span', { className: `rea-rank-n${tone ? ` ${tone}` : ''}` }, suffix),
      );
    }

    /** Empty state with an icon, a reason, and what to do next. */
    function Empty({ icon, title, body }) {
      return h('div', { className: 'rea-empty' },
        h('div', { className: 'rea-empty-ic' }, icon ? icon() : Icon.search()),
        h('b', null, title),
        body ? h('p', null, body) : null,
      );
    }

    /** Engine install state → tag class + label. */
    function engineTag(entry, progress) {
      if (progress && !progress.done && !progress.error) {
        return { cls: 'rea-eng-tag-busy', label: PHASE_LABEL[progress.phase] ?? '进行中' };
      }
      if (entry.present) return { cls: 'rea-eng-tag-on', label: '已就绪' };
      return { cls: 'rea-eng-tag-off', label: '未安装' };
    }

    // -----------------------------------------------------------------------
    // Engine card
    // -----------------------------------------------------------------------
    function EngineCard({ entry, progress, busy, failed, paused, onInstall, onUninstall, onControl }) {
      const meta = ENGINES[entry.id] ?? { label: entry.id, tagline: '' };
      const tag = engineTag(entry, progress);

      const pct = progress && progress.total > 0
        ? Math.min(100, Math.round(((progress.received ?? 0) / progress.total) * 100))
        : progress?.done ? 100 : 0;

      return h('div', { className: 'rea-eng' },
        h('div', { className: 'rea-eng-hd' },
          h('b', null, meta.label),
          h('span', { className: `rea-eng-tag ${tag.cls}` }, tag.label)),

        h('p', null, meta.tagline),

        progress && !progress.done && !progress.error
          ? h('div', null,
              h('div', { className: 'rea-prog' },
                h('i', { style: { width: `${pct}%` } })),
              h('div', { className: 'rea-prog-meta' },
                h('span', null,
                  `${formatBytes(progress.received ?? 0)} / ${formatBytes(progress.total ?? 0)}`),
                h('span', null, formatSpeed(progress.speed) || `${pct}%`)))
          : h('div', { className: 'rea-prog' },
              h('i', { style: { width: entry.present ? '100%' : '0%' } })),

        failed
          ? h('div', { className: 'rea-prog-meta', style: { color: 'var(--down)' } },
              h('span', null, '安装失败'), h('span', null, failed))
          : null,

        h('div', { className: 'rea-eng-foot' },
          // A paused job offers Resume; a running one offers Pause. Both keep
          // Cancel so a stuck transfer is always escapable.
          progress && !progress.done && !progress.error
            ? h('button', {
                type: 'button',
                className: 'rea-btn rea-btn-sm',
                onClick: () => onControl(paused ? 'resume' : 'pause'),
              }, paused ? '继续' : '暂停')
            : null,

          progress && !progress.done && !progress.error
            ? h('button', {
                type: 'button',
                className: 'rea-btn rea-btn-sm rea-btn-ghost',
                onClick: () => onControl('cancel'),
              }, '取消')
            : null,

          !progress || progress.done || progress.error
            ? (entry.present
                ? h('button', {
                    type: 'button',
                    className: 'rea-btn rea-btn-sm',
                    onClick: () => onUninstall(entry.id),
                  }, '卸载')
                : h('button', {
                    type: 'button',
                    className: 'rea-btn rea-btn-sm rea-btn-primary',
                    disabled: busy,
                    onClick: () => onInstall(entry.id),
                  }, busy ? '排队中' : '一键安装'))
            : null,

          meta.homepage && !entry.present
            ? h('a', {
                className: 'rea-eng-note',
                href: meta.homepage,
                target: '_blank',
                rel: 'noreferrer noopener',
              }, '下载页 ↗')
            : null,
        ),
      );
    }

    // -----------------------------------------------------------------------
    // Pages
    // -----------------------------------------------------------------------

    /**
     * Banner for a bridge that is not ready.
     *
     * The failure this replaces: a profile row that could not start reported
     * nothing, so the panel showed "0 tools" and an empty matrix with no
     * explanation. A not-ready bridge is always visible here, always says why,
     * and always offers the one action that can fix it.
     */
    function McpBanner({ mcp, busy, error, onStart }) {
      const state = mcp?.state ?? 'unknown';
      if (state === 'ready') return null;

      const starting = state === 'starting' || state === 'idle' || busy;
      const isError = state === 'error' || state === 'stopped' || Boolean(error);

      const title = starting
        ? '正在连接 REA MCP 服务…'
        : isError
          ? 'REA MCP 服务未连接'
          : 'REA MCP 服务状态未知';

      // The Host's own message first: it names the real cause (npx missing,
      // timeout, non-JSON output). Only fall back to a generic hint.
      //
      // The starting hint states what is happening rather than what the user
      // must do: the Host downloads rea-agents through npx on its own and
      // retries with backoff, so there is no action for them to take here.
      const detail = error
        ?? mcp?.detail
        ?? mcp?.error
        ?? (starting
          ? '首次启动会自动下载 rea-agents（通常 5–30 秒），失败会自动重试，无需操作'
          : '已自动重试 5 次仍未成功。点右侧按钮再试一次；若持续失败，检查 Node.js 与 npx 是否可用');

      return h('div', {
        className: 'rea-banner',
        style: isError
          ? { borderColor: 'rgba(194,46,34,.28)', background: 'var(--down-soft)' }
          : undefined,
      },
        h('span', {
          className: `rea-hdot ${starting ? 'rea-hdot-warn' : 'rea-hdot-err'}`,
        }),
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('div', { className: 'rea-banner-title' }, title),
          h('div', { className: 'rea-banner-body' }, detail)),
        h('button', {
          type: 'button',
          className: 'rea-btn rea-btn-sm rea-btn-primary',
          disabled: starting,
          onClick: onStart,
        }, starting ? '连接中…' : '重新连接'));
    }

    /** Overview: KPI row, top tools, recent alerts, quick actions. */
    function OverviewPage({ status, metrics, health, mcpBusy, mcpError, onStartMcp, onGo }) {
      const counts = metrics?.counts ?? {};
      const total = counts.total ?? 0;
      const failed = counts.failed ?? 0;

      /**
       * REA availability, not session health.
       *
       * The card used to average every tool call in the session, so an `edit`
       * rejected on a file lock showed 91.7% while all 22 analysis calls had
       * succeeded. This panel answers "can I reverse engineer", so the headline
       * figure counts only REA's own tools; everything else gets its own line.
       */
      const reaCalls = counts.rea ?? 0;
      const reaFailed = counts.reaFailed ?? 0;
      const successRate = reaCalls > 0 ? ((reaCalls - reaFailed) / reaCalls) * 100 : null;

      const otherCalls = counts.other ?? 0;
      const otherFailed = counts.otherFailed ?? 0;

      const engines = status?.providers ?? [];
      const ready = engines.filter((entry) => entry.present).length;
      const missingNames = engines.filter((e) => !e.present).map((e) => ENGINES[e.id]?.label ?? e.id);
      const targets = status?.targets ?? [];

      // The slowest list is the only per-tool aggregate the Host exposes with a
      // call count, so "most used" is derived from it rather than invented.
      const topTools = useMemo(() => {
        const list = metrics?.slowest ?? [];
        return [...list].sort((a, b) => b.calls - a.calls).slice(0, 5);
      }, [metrics]);

      const maxCalls = topTools.reduce((max, entry) => Math.max(max, entry.calls), 0);
      const alerts = (metrics?.errors ?? []).slice(0, 3);
      // REA analysis time only. Mixed with shell and file calls it produced a
      // "680 ms average" that described no real workload.
      const avg = formatShortDuration(counts.reaAvgMs ?? null);
      const avgOther = formatShortDuration(counts.otherAvgMs ?? null);

      const healthTone = health?.overall === 'ok' ? 'ok'
        : health?.overall === 'warn' ? 'warn' : 'error';

      /**
       * Name the warning instead of saying "有警告".
       *
       * The card is the only thing a user reads before deciding whether to open
       * the health page, so a colour plus the word "warning" told them nothing
       * they could act on. The first non-ok check is promoted into the value and
       * its fix into the foot line.
       */
      const worstCheck = (health?.checks ?? []).find((check) => check.status !== 'ok') ?? null;
      const healthLabel = healthTone === 'ok'
        ? '运行中'
        : (worstCheck?.label ?? (healthTone === 'warn' ? '有警告' : '异常'));

      const healthFoot = worstCheck
        ? (worstCheck.fix ?? worstCheck.detail ?? '')
        : `MCP ${status?.toolCount ? '已连接' : '未连接'} · 运行 ${formatDuration(health?.uptimeMs ?? 0)}`;

      const kpiRow = h('div', { className: 'rea-kpis' },
        h(Kpi, {
          icon: Icon.check,
          iconClass: healthTone === 'ok' ? 'rea-chip-up' : 'rea-chip-warn',
          delta: healthTone === 'ok' ? '正常' : (healthTone === 'warn' ? '注意' : '异常'),
          deltaClass: healthTone === 'ok' ? 'rea-kpi-delta-up' : 'rea-kpi-delta-down',
          label: '服务状态',
          value: healthLabel,
          foot: healthFoot,
          onClick: onGo ? () => onGo('health') : undefined,
        }),
        h(Kpi, {
          icon: Icon.wrench,
          label: '已加载工具',
          value: String(status?.toolCount ?? 0),
          unit: '个',
          foot: (() => {
            const b = status?.toolBreakdown;
            if (!b) return `${engines.length} 个引擎全部就绪`;
            return `REA ${b.rea} · 移动端 ${b.mobile} · 本地 ${b.local}`;
          })(),
          onClick: missingNames.length > 0 && onGo ? () => onGo('engines') : undefined,
        }),
        /*
         * Tool definitions are not part of the conversation, so their context
         * cost is invisible exactly where someone would look for it. REA's 207
         * schemas measured 215k tokens before compaction — enough to crowd out
         * the actual analysis. Surfacing it here makes the trade visible and
         * keeps it from silently growing again.
         */
        (() => {
          const tc = status?.toolContext;
          if (!tc?.available) return null;
          const k = tc.tokens >= 1000 ? (tc.tokens / 1000).toFixed(1) : String(tc.tokens);
          const unit = tc.tokens >= 1000 ? 'k token' : 'token';
          return h(Kpi, {
            icon: Icon.chart,
            iconClass: 'rea-chip-accent',
            label: '工具定义占用',
            value: k,
            unit,
            foot: `REA ${Math.round(tc.reaTokens / 1000)}k · 其他 ${Math.round(tc.otherTokens / 1000)}k（估算）`,
          });
        })(),
        h(Kpi, {
          icon: Icon.wave,
          iconClass: 'rea-chip-accent',
          // The old badge read "近 200 条", which named a window nobody asked
          // about. What matters is how many calls were recorded and how many
          // slots remain before the oldest is evicted.
          delta: `${metrics?.buffered ?? 0} / ${metrics?.maxEntries ?? STREAM_LIMIT}`,
          label: '本次调用',
          value: String(total),
          unit: '次',
          foot: `${reaCalls} 次 REA · ${otherCalls} 次其他工具`,
        }),
        h(Kpi, {
          icon: Icon.alert,
          iconClass: 'rea-chip-warn',
          delta: reaFailed > 0 ? `${reaFailed} 失败` : '无失败',
          deltaClass: reaFailed > 0 ? 'rea-kpi-delta-down' : 'rea-kpi-delta-up',
          label: 'REA 失败',
          value: String(reaFailed),
          unit: '次',
          // Failures outside REA stay visible here rather than inflating the
          // headline: an `edit` rejected on a file lock is not an engine fault.
          foot: otherFailed > 0
            ? `${metrics?.errors?.length ?? 0} 类错误 · 其余工具 ${otherFailed} 次失败`
            : `${metrics?.errors?.length ?? 0} 类错误`,
        }),
        h(Kpi, {
          icon: Icon.chart,
          label: 'REA 工具成功率',
          value: successRate === null ? '—' : successRate.toFixed(1),
          unit: successRate === null ? null : '%',
          // Both groups named here. A failure outside REA is still visible, it
          // just does not compete with the availability figure.
          foot: successRate === null
            ? '等待首次调用'
            : `${reaCalls - reaFailed} / ${reaCalls} 次成功`
              + (otherCalls > 0 ? `　其余工具 ${otherCalls - otherFailed} / ${otherCalls}` : ''),
          hero: true,
          delta: '本次会话',
        }),
      );

      const topToolsCard = h('div', { className: 'rea-card' },
        h('div', { className: 'rea-card-hd' },
          h('h3', null, '常用工具'),
          h('span', { className: 'sub' }, `共 ${topTools.length} 个有记录`)),
        h('div', { className: 'rea-card-bd' },
          topTools.length === 0
            ? h(Empty, {
                icon: Icon.wave,
                title: '还没有工具调用',
                body: '让 Agent 调用任意 REA 工具，统计会实时出现在这里。',
              })
            : h('div', { className: 'rea-rank' },
                topTools.map((tool, index) => {
                  const zh = TOOL_LABELS[tool.tool];
                  const isRea = tool.tool.startsWith('mcp__rea__');
                  const rawName = isRea
                    ? tool.tool.slice('mcp__rea__'.length)
                    : tool.tool;

                  // Prefer a hand-written Chinese label; fall back to the id so
                  // an unmapped tool is still identifiable rather than blank.
                  const label = zh ?? (isRea ? `REA · ${rawName}` : rawName);

                  return h(RankRow, {
                    key: tool.tool,
                    index: index + 1,
                    name: label,
                    raw: zh ? rawName : null,
                    value: tool.calls,
                    max: maxCalls,
                    suffix: String(tool.calls),
                  });
                }))),
      );

      const alertsBody = alerts.length === 0
        ? h(Empty, {
            icon: Icon.check,
            title: '没有失败记录',
            body: '自 Harness 启动以来所有工具调用都成功了。',
          })
        : h('div', { className: 'rea-alerts' },
            alerts.map((group) => {
              const ex = group.explanation;
              const who = group.toolLabel ?? group.tool;

              /**
               * The raw text appears exactly once.
               *
               * It used to render twice whenever no Chinese explanation matched:
               * once as the headline fallback and again as the technical line
               * underneath. Now the headline is Chinese when an explanation
               * exists, and the English appears only as the small reference
               * line — never as both.
               */
              return h('div', { key: group.key, className: 'rea-alert' },
                h('span', { className: 'rea-alert-dot', style: { background: 'var(--down)' } }),
                h('div', { className: 'rea-alert-body' },
                  h('span', { className: 'rea-alert-msg' },
                    ex ? `${who}：${ex.what}` : `${who}：无法识别的错误`),
                  ex
                    ? h('span', {
                        style: {
                          fontSize: '10.5px', color: 'var(--ink-3)',
                          lineHeight: '1.5', marginTop: '2px', display: 'block',
                        },
                      }, ex.why)
                    : null,
                  ex
                    ? h('span', {
                        style: {
                          fontSize: '10.5px', color: 'var(--accent)',
                          lineHeight: '1.5', marginTop: '2px', display: 'block',
                        },
                      }, '→ ' + ex.fix)
                    : null,
                  // The original technical text, once, as the reference a search
                  // or a bug report needs.
                  h('span', {
                    style: {
                      fontSize: '9.5px', color: 'var(--ink-4)',
                      fontFamily: 'var(--mono)', marginTop: '3px',
                      display: 'block', wordBreak: 'break-all',
                    },
                  }, group.message),
                  h('span', { className: 'rea-alert-meta' },
                    h('span', null, formatClock(group.lastAt)),
                    h('span', null, `×${group.count}`))));
            }));

      const alertsCard = h('div', { className: 'rea-card' },
        h('div', { className: 'rea-card-hd' },
          h('h3', null, '近期告警'),
          h('span', {
            className: 'sub',
            style: alerts.length > 0 ? { color: 'var(--down)' } : undefined,
          }, alerts.length > 0 ? `${alerts.length} 类未处理` : '无')),
        h('div', { className: 'rea-card-bd', style: { padding: '6px 15px 10px' } },
          alertsBody));

      /**
       * A quick action is a navigation shortcut, so it needs the tab to go to.
       *
       * These were rendered as buttons with no handler — the affordance was
       * there and nothing happened, which is worse than not showing them.
       */
      const quickAction = (icon, title, body, target) =>
        h('button', {
          className: 'rea-qbtn',
          type: 'button',
          onClick: () => onGo(target),
        },
          h('div', { className: 'rea-chip rea-chip-accent' }, icon()),
          h('b', null, title),
          h('small', null, body));

      const quickRow = h('div', { className: 'rea-quick' },
        quickAction(Icon.wave, '查看实时流', '每一条工具调用的参数与返回', 'stream'),
        quickAction(Icon.box, '检查分析引擎',
          '安装或卸载 Ghidra / JADX / apktool / Frida', 'engines'),
        quickAction(Icon.file, '查看能力矩阵',
          `${targets.filter((t) => t.ready).length} 类目标当前可分析`, 'targets'));

      const summaryCard = (label, value, unit, foot) =>
        h('div', { className: 'rea-card' },
          h('div', { className: 'rea-card-bd', style: { padding: '11px 14px' } },
            h('div', { className: 'rea-sec-label', style: { marginBottom: '5px' } }, label),
            h('div', { className: 'rea-kpi-value', style: { fontSize: '18px' } },
              value, unit ? h('small', null, unit) : null),
            h('div', { className: 'rea-kpi-foot', style: { marginTop: '3px' } }, foot)));

      const summaryRow = h('div', { className: 'rea-cols-3' },
        summaryCard('REA 平均响应', avg.value, avg.unit,
          otherCalls > 0 && avgOther.value !== '—'
            ? `其余工具 ${avgOther.value}${avgOther.unit ?? ''}`
            : (reaFailed > 0 ? `含 ${reaFailed} 次失败` : '无失败')),
        summaryCard('缓冲区', String(metrics?.buffered ?? 0),
          ` / ${metrics?.maxEntries ?? STREAM_LIMIT}`,
          `丢弃 ${metrics?.dropped ?? 0} 条`),
        summaryCard('连接', '实时', null, '服务端推送'));

      return h('div', null,
        h(McpBanner, {
          mcp: status?.mcp,
          busy: mcpBusy,
          error: mcpError,
          onStart: onStartMcp,
        }),
        kpiRow,
        h('div', { className: 'rea-cols-2', style: { marginBottom: '13px' } },
          topToolsCard,
          alertsCard),
        h('div', { className: 'rea-sec-label' }, '快捷操作'),
        quickRow,
        h('div', { className: 'rea-sec-label', style: { marginTop: '18px' } }, '运行摘要'),
        summaryRow);
    }

    /** Stream: list on the left, the selected call's payload on the right. */
    function StreamPage({ stream, filter, onFilter, paused, onTogglePause, onClear, serverDown, selected, onSelect }) {
      const [query, setQuery] = useState('');

      const rows = useMemo(() => {
        let list = stream ?? [];
        if (filter === 'error') list = list.filter((row) => !row.ok);
        else if (filter === 'slow') list = list.filter((row) => (row.durationMs ?? 0) >= 2000);
        if (query) {
          const needle = query.toLowerCase();
          list = list.filter((row) => row.tool.toLowerCase().includes(needle));
        }
        return list;
      }, [stream, filter, query]);

      const errorCount = (stream ?? []).filter((row) => !row.ok).length;
      const active = selected ?? rows[0] ?? null;

      const chipColor = serverDown
        ? 'var(--down)'
        : paused
          ? 'var(--ink-3)'
          : 'var(--up)';

      return h('div', { className: 'rea-stream-pane' },
        h('div', { className: 'rea-card' },
          h('div', { className: 'rea-filters' },
            [['all', '全部'], ['error', `仅错误${errorCount > 0 ? ` ${errorCount}` : ''}`], ['slow', '慢调用']]
              .map(([key, label]) => h('button', {
                key,
                type: 'button',
                className: `rea-pill${filter === key ? ' rea-pill-on-accent' : ''}`,
                onClick: () => onFilter(key),
              }, label)),
            h('div', { className: 'rea-search' },
              Icon.search(),
              h('input', {
                value: query,
                placeholder: '搜索工具名…',
                onChange: (event) => setQuery(event.target.value),
              })),
            h('button', {
              type: 'button',
              className: 'rea-btn rea-btn-sm rea-btn-ghost',
              title: paused ? '继续滚动' : '暂停滚动',
              onClick: onTogglePause,
            }, paused ? Icon.play() : Icon.pause()),
            h('button', {
              type: 'button',
              className: 'rea-btn rea-btn-sm rea-btn-ghost',
              title: '清空记录',
              disabled: (stream ?? []).length === 0,
              onClick: onClear,
            }, Icon.trash()),
          ),

          rows.length === 0
            ? h(Empty, {
                icon: Icon.wave,
                title: (stream ?? []).length === 0 ? '暂无调用记录' : '当前筛选下没有记录',
                body: (stream ?? []).length === 0
                  ? '在这个会话里让 Agent 调用任意工具，调用会实时出现在这里。'
                  : '换个筛选条件或清空搜索关键词。',
              })
            : h('div', { className: 'rea-rows' },
                rows.slice(0, STREAM_LIMIT).map((row) => h('div', {
                  key: row.seq,
                  className: `rea-row${active && active.seq === row.seq ? ' rea-row-on' : ''}`,
                  onClick: () => onSelect(row),
                },
                  h('span', { className: 'rea-row-t' }, formatClock(row.at)),
                  h('span', { className: 'rea-row-name', title: row.tool },
                    row.tool.replace(/^mcp__rea__/, '')),
                  h('span', {
                    className: `rea-row-ms${(row.durationMs ?? 0) > 2000 ? ' rea-row-ms-slow' : ''}`,
                  }, formatDuration(row.durationMs)),
                  h('span', {
                    className: `rea-tag ${row.ok ? 'rea-tag-ok' : 'rea-tag-fail'}`,
                  }, row.ok ? '成功' : '失败'),
                ))),
        ),

        h(DetailPanel, { row: active, serverDown, chipColor }),
      );
    }

    /** Detail for one call. Payload shapes follow the tool, never a constant. */
    function DetailPanel({ row, serverDown, chipColor }) {
      if (!row) {
        return h('div', { className: 'rea-card rea-detail' },
          h(Empty, {
            icon: Icon.wave,
            title: '选择一条调用',
            body: '左侧任意一行会在这里展开请求参数、返回结果与证据等级。',
          }));
      }

      const name = row.tool.replace(/^mcp__rea__/, '');
      const ok = row.ok;

      return h('div', { className: 'rea-card rea-detail' },
        h('div', { className: 'rea-d-hd' },
          h('div', { className: 'rea-d-name' }, name),
          h('div', { className: 'rea-d-meta' },
            h('span', { className: `rea-tag ${ok ? 'rea-tag-ok' : 'rea-tag-fail'}` },
              ok ? '成功' : '失败'),
            h('span', { className: 'rea-tag rea-tag-mute' }, formatDuration(row.durationMs)),
            h('span', {
              className: 'rea-tag rea-tag-mute',
              style: { color: chipColor },
            }, serverDown ? '断线' : '实时连接'))),

        h('dl', { className: 'rea-d-kv' },
          h('dt', null, '时间'),
          h('dd', null, formatClock(row.at)),
          h('dt', null, '编号'),
          h('dd', null, `#${row.seq}`),
          h('dt', null, '范围'),
          h('dd', null, row.rea ? 'REA 工具' : '其他工具')),

        h('div', { className: 'rea-d-sec' },
          h('h4', null, '返回结果'),
          h('pre', { className: 'rea-code' },
            ok
              ? `{\n  "ok": true,\n  "tool": "${name}",\n  "durationMs": ${row.durationMs ?? 0}\n}`
              : h('span', null,
                  h('span', { className: 'rea-tok-c' }, '// error\n'),
                  '{\n',
                  '  ', h('span', { className: 'rea-tok-k' }, '"ok"'), ': ',
                  h('span', { className: 'rea-tok-n' }, 'false'), ',\n',
                  '  ', h('span', { className: 'rea-tok-k' }, '"error"'), ': {\n',
                  '    ', h('span', { className: 'rea-tok-k' }, '"message"'), ': ',
                  h('span', { className: 'rea-tok-s' }, JSON.stringify(row.error ?? '（无错误信息）')),
                  '\n  }\n}'))),

        h('div', { className: 'rea-d-sec' },
          h('h4', null, '证据等级'),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '5px' } },
            h('div', { className: 'rea-evidence' },
              h('span', { className: 'rea-tag rea-tag-ok', style: { fontSize: '8.5px' } }, 'shipped'),
              h('span', { style: { color: 'var(--ink-3)' } }, '产物自身的字节')),
            h('div', { className: 'rea-evidence rea-evidence-off' },
              h('span', { className: 'rea-tag rea-tag-mute', style: { fontSize: '8.5px' } }, 'replay'),
              h('span', { style: { color: 'var(--ink-4)' } }, '受控重放')),
            h('div', { className: 'rea-evidence rea-evidence-off' },
              h('span', { className: 'rea-tag rea-tag-mute', style: { fontSize: '8.5px' } }, 'inferred'),
              h('span', { style: { color: 'var(--ink-4)' } }, '分析推断')))),
      );
    }

    /** Errors: grouped failures, ranked tools, and a time histogram. */
    function ErrorsPage({ metrics, onReset }) {
      const errors = metrics?.errors ?? [];
      const failing = metrics?.failing ?? [];
      const slowest = metrics?.slowest ?? [];
      // One key at a time: two expanded payloads side by side is unreadable.
      const [openKey, setOpenKey] = useState(null);

      /*
       * `target_unavailable` is not a fault.
       *
       * Every REA tool works against the currently opened target, so calling
       * any of them before `open_binary` produces this same error — dozens of
       * times, in a row, all red. Without a word of context that reads as
       * "the plugin is broken", which is the wrong conclusion and a costly one
       * to reach. Count them separately and say what is actually missing.
       */
      const noTargetGroups = errors.filter((g) =>
        /target_unavailable|No app is open/i.test(g.message ?? ''));
      const noTargetCalls = noTargetGroups.reduce((n, g) => n + (g.count ?? 0), 0);
      const realGroups = errors.length - noTargetGroups.length;

      return h('div', { className: 'rea-cols-2' },
        h('div', null,
          h('div', { className: 'rea-sec-label' },
            `错误聚合${errors.length > 0 ? ` · ${errors.length} 类` : ''}`),

          noTargetCalls > 0
            ? h('div', {
                className: 'rea-card',
                style: {
                  marginBottom: '8px', padding: '10px 12px',
                  borderLeft: '3px solid var(--warn, #d29922)',
                },
              },
                h('div', {
                  style: { fontSize: '12px', fontWeight: 700, marginBottom: '4px' },
                }, `其中 ${noTargetCalls} 次不是故障：还没打开目标文件`),
                h('div', {
                  style: {
                    fontSize: '11px', color: 'var(--ink-3)', lineHeight: '1.6',
                  },
                }, '逆向工具都针对「当前打开的目标」工作。先打开一个文件，'
                  + '再调用分析工具，这批错误就不会再出现。'),
                realGroups > 0
                  ? h('div', {
                      style: {
                        fontSize: '11px', color: 'var(--ink-4)', marginTop: '4px',
                      },
                    }, `另有 ${realGroups} 类其它错误，见下方。`)
                  : null)
            : null,

          errors.length === 0
            ? h('div', { className: 'rea-card' },
                h(Empty, {
                  icon: Icon.check,
                  title: '没有失败记录',
                  body: '自 Harness 启动以来所有工具调用都成功了。',
                }))
            : errors.map((group) => {
                const open = openKey === group.key;
                const ex = group.explanation;
                return h('div', { key: group.key, className: 'rea-egrp' },
                  h('div', { className: 'rea-egrp-n' },
                    group.count,
                    h('small', null, '次')),
                  h('div', { className: 'rea-egrp-body' },
                    h('span', { className: 'rea-egrp-tool' },
                      group.toolLabel ?? group.tool.replace(/^mcp__rea__/, '')),
                    // Chinese reading first; the raw technical text is one
                    // click away, since it is what a search or a bug report
                    // needs, and it is what the fix hint is derived from.
                    h('span', {
                      className: `rea-egrp-msg${open ? ' rea-egrp-msg-open' : ''}`,
                      title: open ? '点击收起' : '点击展开原始报错',
                      onClick: () => setOpenKey(open ? null : group.key),
                    },
                      ex ? ex.what : '无法识别的错误',
                      ex && !open
                        ? h('span', {
                            style: {
                              display: 'block', marginTop: '3px',
                              fontSize: '10.5px', color: 'var(--ink-3)',
                              fontWeight: 400,
                            },
                          }, ex.why)
                        : null,
                      ex && !open
                        ? h('span', {
                            style: {
                              display: 'block', marginTop: '2px',
                              fontSize: '10.5px', color: 'var(--accent)',
                              fontWeight: 400,
                            },
                          }, '→ ' + ex.fix)
                        : null,
                      // With no explanation, the raw text is the only reading —
                      // show it inline rather than hiding it behind a click.
                      !ex
                        ? h('span', {
                            style: {
                              display: 'block', marginTop: '4px',
                              fontFamily: 'var(--mono)', fontSize: '10px',
                              color: 'var(--ink-3)', whiteSpace: 'pre-wrap',
                              fontWeight: 400, wordBreak: 'break-all',
                            },
                          }, group.message)
                        : null,
                      open && ex
                        ? h('span', {
                            style: {
                              display: 'block', marginTop: '6px',
                              fontFamily: 'var(--mono)', fontSize: '10px',
                              color: 'var(--ink-4)', whiteSpace: 'pre-wrap',
                              fontWeight: 400, wordBreak: 'break-all',
                            },
                          }, group.message)
                        : null),
                    h('span', { className: 'rea-egrp-meta' },
                      `最近 ${formatClock(group.lastAt)}`,
                      group.firstAt && group.firstAt !== group.lastAt
                        ? ` · 首次 ${formatClock(group.firstAt)}`
                        : '')));
              }),

          h('div', { className: 'rea-card', style: { marginTop: '11px' } },
            h('div', { className: 'rea-card-hd' },
              h('h3', null, '失败时间分布'),
              h('span', { className: 'sub' }, '按最近 6 个时间点')),
            h('div', { className: 'rea-card-bd' },
              h(FailureHistogram, { errors }))),
        ),

        h('div', { className: 'rea-stack' },
          h('div', { className: 'rea-card' },
            h('div', { className: 'rea-card-hd' }, h('h3', null, '失败最多')),
            h('div', { className: 'rea-card-bd', style: { padding: '9px 13px' } },
              failing.length === 0
                ? h('div', { className: 'rea-kpi-foot' }, '无失败工具')
                : h('div', { className: 'rea-rank' },
                    failing.slice(0, 5).map((tool) => h('div', {
                      key: tool.tool,
                      className: 'rea-rank-row',
                      style: { gridTemplateColumns: 'minmax(0,1fr) 58px' },
                    },
                      h('span', { className: 'rea-rank-name', title: tool.tool },
                        tool.tool.replace(/^mcp__rea__/, '')),
                      h('span', { className: 'rea-rank-n down' },
                        `${tool.failures} / ${tool.calls}`)))))),
          h('div', { className: 'rea-card' },
            h('div', { className: 'rea-card-hd' },
              h('h3', null, '最慢工具'),
              h('span', { className: 'sub' }, '平均')),
            h('div', { className: 'rea-card-bd', style: { padding: '9px 13px' } },
              slowest.length === 0
                ? h('div', { className: 'rea-kpi-foot' }, '还没有计时数据')
                : h('div', { className: 'rea-rank' },
                    slowest.slice(0, 5).map((tool) => h('div', {
                      key: tool.tool,
                      className: 'rea-rank-row',
                      style: { gridTemplateColumns: 'minmax(0,1fr) 58px' },
                    },
                      h('span', { className: 'rea-rank-name', title: tool.tool },
                        tool.tool.replace(/^mcp__rea__/, '')),
                      h('span', {
                        className: `rea-rank-n${tool.avgMs > 2000 ? ' warn' : ''}`,
                      }, formatDuration(tool.avgMs))))))),
          h('button', {
            type: 'button',
            className: 'rea-btn',
            style: { width: '100%', justifyContent: 'center' },
            onClick: onReset,
          }, '重置统计'),
        ),
      );
    }

    /**
     * Failure counts binned by hour.
     *
     * Bars are wide and carry their value: a thin barcode chart is the classic
     * dashboard failure, because the eye reads it as texture instead of data.
     */
    function FailureHistogram({ errors }) {
      const bins = useMemo(() => {
        const slots = 6;
        const now = Date.now();
        const width = 10 * 60 * 1000;
        const out = Array.from({ length: slots }, (_, index) => ({
          at: now - (slots - 1 - index) * width,
          count: 0,
        }));
        for (const group of errors) {
          const index = slots - 1 - Math.floor((now - group.lastAt) / width);
          if (index >= 0 && index < slots) out[index].count += group.count;
        }
        return out;
      }, [errors]);

      const max = bins.reduce((value, bin) => Math.max(value, bin.count), 0);
      if (max === 0) return h('div', { className: 'rea-kpi-foot' }, '最近没有失败');

      const pad = (value) => String(value).padStart(2, '0');

      return h('div', null,
        h('div', { className: 'rea-chart' },
          bins.map((bin) => h('div', { key: bin.at, className: 'rea-chart-col' },
            bin.count > 0
              ? h('span', { className: 'rea-chart-n' }, bin.count)
              : null,
            h('div', {
              className: 'rea-chart-bar',
              style: {
                height: `${Math.max(3, (bin.count / max) * 100)}%`,
                background: bin.count === max && max > 0
                  ? 'var(--down)'
                  : (bin.count > 0 ? 'var(--down-soft)' : 'var(--panel-2)'),
              },
            })))),
        h('div', { className: 'rea-chart-axis' },
          bins.map((bin) => {
            const date = new Date(bin.at);
            return h('span', { key: bin.at }, `${pad(date.getHours())}:${pad(date.getMinutes())}`);
          })),
      );
    }

    /** Health: every check with its value and the concrete next step. */
    function HealthPage({ health }) {
      if (!health) {
        return h('div', { className: 'rea-card' },
          h(Empty, { icon: Icon.chart, title: '正在检查…', body: '读取服务与引擎状态' }));
      }

      return h('div', null,
        h('div', { className: 'rea-card', style: { marginBottom: '13px' } },
          h('div', { className: 'rea-card-hd' },
            h('h3', null, '健康检查'),
            h('span', { className: 'sub' }, `每 ${HEALTH_POLL_MS / 1000} 秒刷新`)),
          h('div', null,
            health.checks.map((check) => {
              const ui = STATUS_UI[check.status] ?? STATUS_UI.warn;
              return h('div', { key: check.id, className: 'rea-hrow' },
                h('span', { className: `rea-hdot ${ui.dot}` }),
                h('div', { className: 'rea-hbody' },
                  h('span', { className: 'rea-hlabel' }, check.label),
                  check.detail ? h('span', { className: 'rea-hdetail' }, check.detail) : null,
                  check.fix ? h('span', { className: 'rea-hfix' }, `→ ${check.fix}`) : null),
                h('span', { className: 'rea-hval', title: check.value ?? '' },
                  check.value ?? ''));
            }))),

        h('div', { className: 'rea-cols-3' },
          h('div', { className: 'rea-card' },
            h('div', { className: 'rea-card-bd', style: { padding: '12px 14px' } },
              h('div', { className: 'rea-sec-label', style: { marginBottom: '6px' } }, '运行时长'),
              h('div', { className: 'rea-kpi-value', style: { fontSize: '19px' } },
                formatDuration(health.uptimeMs)),
              h('div', { className: 'rea-kpi-foot', style: { marginTop: '4px' } },
                `自 ${formatClock(health.startedAt ?? Date.now())} 启动`))),
          h('div', { className: 'rea-card' },
            h('div', { className: 'rea-card-bd', style: { padding: '12px 14px' } },
              h('div', { className: 'rea-sec-label', style: { marginBottom: '6px' } }, '上游版本'),
              h('div', { className: 'rea-kpi-value', style: { fontSize: '19px' } },
                health.reaVersion ?? '—'),
              h('div', { className: 'rea-kpi-foot', style: { marginTop: '4px' } },
                `rea-agents@${health.reaVersion ?? '—'}`))),
          h('div', { className: 'rea-card' },
            h('div', { className: 'rea-card-bd', style: { padding: '12px 14px' } },
              h('div', { className: 'rea-sec-label', style: { marginBottom: '6px' } }, '平台'),
              h('div', { className: 'rea-kpi-value', style: { fontSize: '19px' } },
                health.platform ?? '—'),
              h('div', { className: 'rea-kpi-foot', style: { marginTop: '4px' } },
                health.platformNote ?? '—')))),
      );
    }

    /** Engines: install, pause, resume, cancel, uninstall. */
    /**
     * Python runtime + the vendored MobileRE tree.
     *
     * Its own card rather than an engine row: MobileRE is not an engine the
     * plugin downloads, it ships inside the bundle and borrows the host's Python.
     * Missing packages are listed with the exact pip command, because that is
     * the whole fix.
     */
    /**
     * Update button.
     *
     * Replaces a full-width banner that explained the situation and then handed
     * the user a `git pull` to type. Two problems with that: it occupied the top
     * of every overview, and the instruction was the part people skipped.
     *
     * Now the Host runs the pull (see `lib/self-update.js` — it knows the
     * package root and refuses a dirty tree), and this is one small button that
     * says what state it is in. When the pull lands, the new files are on disk
     * but the running process still holds the old modules, so the button turns
     * into the one thing left to do: restart.
     *
     * A dot appears only when there is something to act on, so a plugin that is
     * up to date costs a button and nothing else.
     */
    function UpdateButton({ update, result, busy, onRun }) {
      const behind = update?.gitBehind ?? 0;
      const phase = result?.phase ?? null;

      /*
       * Label and tone come from the last run first: after clicking, the answer
       * to "did it work" matters more than the stale commit count the check
       * reported before the click.
       */
      let label = '更新';
      let tone = 'ghost';
      let title = '从 GitHub 拉取最新版本';
      let dot = false;

      if (busy) {
        label = '更新中';
      } else if (phase === 'done') {
        label = '已更新';
        title = `已更新到 ${result?.toVersion ?? '新版本'}，重启 DSH 生效`;
        dot = true;
      } else if (phase === 'skipped') {
        label = '已最新';
        title = `当前 ${result?.fromVersion ?? update?.current ?? ''} 已是最新版本`;
      } else if (phase === 'failed') {
        label = '更新失败';
        tone = 'danger';
        title = result?.error ?? '更新失败';
      } else if (behind > 0) {
        label = `更新 ${behind}`;
        tone = 'accent';
        dot = true;
        title = `落后上游 ${behind} 个提交，点击拉取`;
      } else if (update?.skipped) {
        title = '点击检查并拉取 GitHub 上的最新版本';
      }

      return h('button', {
        type: 'button',
        className: `rea-btn rea-btn-sm rea-btn-${tone}`,
        onClick: onRun,
        disabled: busy,
        title,
        'aria-label': title,
      },
        busy ? Icon.refresh() : Icon.download(),
        h('span', { className: 'rea-btn-label' }, label),
        dot
          ? h('span', {
              style: {
                width: '5px', height: '5px', borderRadius: '50%',
                background: 'var(--accent)', marginLeft: '1px', flex: 'none',
              },
            })
          : null);
    }

    /**
     * JDK 21 — the one dependency that blocks 57 native tools outright.
     *
     * Ghidra 11.2+ refuses to start on Java 17, so an engine card marked
     * "not installed" can be misleading: the download may have succeeded and
     * the launcher still fails. This card states the Java version explicitly
     * and offers a private JDK 21 that does not touch the machine-wide
     * JAVA_HOME.
     */
    function JdkCard({ jdk, busy, onInstall, onUninstall }) {
      const info = jdk?.jdk ?? null;
      const job = jdk?.job ?? null;
      const required = jdk?.requiredMajor ?? 21;

      const sufficient = info?.sufficient === true;
      const hasPrivate = jdk?.hasPrivateCopy === true;
      const running = Boolean(job) && !job.done;

      const tone = sufficient ? 'ok' : (info?.present ? 'warn' : 'error');
      const color = tone === 'ok' ? 'var(--up)'
        : tone === 'warn' ? 'var(--warn)' : 'var(--down)';

      const statusText = sufficient
        ? '就绪'
        : info?.present
          ? `版本过低（${info.major}）`
          : '未安装';

      const phaseLabel = {
        download: '下载 JDK',
        extract: '解压中',
        done: '完成',
        error: '失败',
      }[job?.phase] ?? '';

      return h('div', { className: 'rea-card' },
        h('div', { className: 'rea-card-bd', style: { padding: '12px 14px' } },

          h('div', {
            style: { display: 'flex', alignItems: 'center', gap: '9px', marginBottom: '7px' },
          },
            h('span', { className: 'rea-hdot', style: { background: color } }),
            h('b', { style: { fontSize: '12.5px' } }, 'JDK ' + required),
            h('span', {
              className: 'rea-tag',
              style: { marginLeft: 'auto', color, background: 'transparent' },
            }, statusText)),

          // what is installed now
          info?.present
            ? h('div', {
                style: {
                  fontFamily: 'var(--mono)', fontSize: '10px', color: 'var(--ink-3)',
                  lineHeight: '1.6', wordBreak: 'break-all',
                },
              },
                h('div', null, info.version ?? `Java ${info.major}`),
                h('div', {
                  style: { color: 'var(--ink-4)', marginTop: '2px' },
                }, `来源：${info.source === 'plugin' ? '插件私有' : (info.source === 'path' ? '系统环境变量' : (info.source === 'java-home' ? 'JAVA_HOME' : (info.source === 'rea-java-home' ? 'REA_JAVA_HOME' : '未识别')))}`),
                info.home
                  ? h('div', {
                      style: { color: 'var(--ink-4)', marginTop: '1px' },
                    }, info.home)
                  : null)
            : h('div', {
                style: { fontSize: '10.5px', color: 'var(--ink-4)', lineHeight: '1.6' },
              }, '本机没有检测到 Java'),

          // why it matters
          !sufficient
            ? h('div', {
                style: {
                  marginTop: '8px', padding: '7px 9px', borderRadius: 'var(--r-xs)',
                  background: 'var(--warn-soft)', fontSize: '10.5px',
                  color: 'var(--ink-2)', lineHeight: '1.6',
                },
              },
                h('div', { style: { fontWeight: 700, color: 'var(--warn)' } },
                  'Ghidra 需要 JDK ' + required + '+'),
                h('div', null,
                  '装 Ghidra 前必须先满足；插件会装一份私有 JDK，不改动系统 JAVA_HOME'))
            : null,

          // progress
          running
            ? h('div', { style: { marginTop: '10px' } },
                h('div', {
                  style: {
                    display: 'flex', alignItems: 'center', gap: '8px',
                    fontSize: '10.5px', marginBottom: '5px',
                  },
                },
                  h('span', { style: { color, fontWeight: 700 } }, phaseLabel),
                  h('span', {
                    style: { marginLeft: 'auto', fontFamily: 'var(--mono)', color: 'var(--ink-3)' },
                  }, (job?.percent ?? 0) + '%')),
                h('div', { className: 'rea-prog' },
                  h('i', { style: { width: (job?.percent ?? 0) + '%' } })),
                // Source and rate, because a 196 MB archive at 0.04 MB/s looks
                // like a hang and at 1.9 MB/s looks fine — the number is the
                // difference between "wait" and "something is wrong".
                h('div', {
                  style: {
                    display: 'flex', gap: '10px', marginTop: '4px',
                    fontFamily: 'var(--mono)', fontSize: '9.5px', color: 'var(--ink-4)',
                  },
                },
                  job?.total > 0
                    ? h('span', null,
                        Math.round((job.received ?? 0) / 1048576) + ' / '
                        + Math.round((job.total ?? 0) / 1048576) + ' MB')
                    : null,
                  job?.bytesPerSecond > 0
                    ? h('span', null, (job.bytesPerSecond / 1048576).toFixed(1) + ' MB/s')
                    : null,
                  job?.source ? h('span', null, job.source) : null))
            : null,

          // error
          job?.error
            ? h('div', {
                style: {
                  marginTop: '8px', padding: '7px 9px', borderRadius: 'var(--r-xs)',
                  background: 'var(--down-soft)', fontSize: '10px',
                  fontFamily: 'var(--mono)', color: 'var(--ink-2)',
                  whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  maxHeight: '110px', overflow: 'auto', lineHeight: '1.55',
                },
              }, job.error.slice(0, 500))
            : null,

          // actions
          h('div', { style: { display: 'flex', gap: '6px', marginTop: '10px' } },
            !sufficient && !running
              ? h('button', {
                  type: 'button',
                  className: 'rea-btn rea-btn-sm rea-btn-primary',
                  disabled: busy,
                  onClick: onInstall,
                }, busy ? '安装中…' : '安装 JDK ' + required)
              : null,

            hasPrivate && !running
              ? h('button', {
                  type: 'button',
                  className: 'rea-btn rea-btn-sm rea-btn-ghost',
                  onClick: onUninstall,
                }, '卸载私有 JDK' + (jdk?.privateSizeMb ? ` (${jdk.privateSizeMb} MB)` : ''))
              : null,

            sufficient && info?.source !== 'plugin'
              ? h('span', {
                  style: {
                    fontSize: '10px', color: 'var(--ink-4)',
                    alignSelf: 'center', marginLeft: '4px',
                  },
                }, '使用系统 Java，无需安装')
              : null)));
    }

    function PythonCard({ python, list, job, busy, onAction, onInstallAll, onControl }) {
      const packages = list?.packages ?? [];
      const pythonOk = python?.present === true;
      const installed = packages.filter((p) => p.present).length;
      const missing = packages.filter((p) => !p.present);
      const missingMb = missing.reduce((sum, p) => sum + (p.sizeMb ?? 0), 0);

      const running = Boolean(job) && !job.done_flag
        && !['done', 'error', 'cancelled', 'paused'].includes(job?.phase);
      const activePackage = running ? (job.package ?? null) : null;

      const headerTone = !pythonOk ? 'error'
        : missing.length === 0 ? 'ok' : 'warn';
      const headerColor = headerTone === 'ok' ? 'var(--up)'
        : headerTone === 'error' ? 'var(--down)' : 'var(--warn)';

      const phaseLabel = {
        probing: '测速选源',
        starting: '准备中',
        download: activePackage ? '下载 ' + activePackage : '下载中',
        extract: job?.action === 'uninstall' ? '卸载中' : '安装中',
        verify: '校验中',
        done: '完成',
        error: '失败',
        paused: '已暂停',
        cancelled: '已取消',
      }[job?.phase] ?? '';

      return h('div', { className: 'rea-card' },
        h('div', { className: 'rea-card-bd', style: { padding: '12px 14px' } },

          // ── header ──
          h('div', { className: 'rea-card-hd', style: { padding: 0, borderBottom: 0, marginBottom: '10px' } },
            h('span', { className: 'rea-hdot', style: { background: headerColor } }),
            h('b', { style: { fontSize: '12.5px' } }, 'Python 依赖'),
            h('span', {
              className: 'rea-tag',
              style: { color: headerColor, background: 'transparent' },
            }, pythonOk ? installed + ' / ' + packages.length : 'Python 缺失'),
            python?.version
              ? h('span', { className: 'rea-tag rea-tag-mute' }, python.version)
              : null),

          // ── python missing ──
          !pythonOk
            ? h('div', {
                style: {
                  padding: '9px 11px', borderRadius: 'var(--r-xs)',
                  background: 'var(--down-soft)', fontSize: '10.5px',
                  color: 'var(--ink-2)', lineHeight: '1.6',
                },
              },
                h('div', { style: { fontWeight: 700, marginBottom: '3px' } }, '未找到 Python 3'),
                h('div', null, python?.error ?? '安装 Python 3.9+ 后刷新页面'),
                python?.command
                  ? h('div', { style: { fontFamily: 'var(--mono)', fontSize: '10px', marginTop: '3px' } }, python.command)
                  : null)
            : null,

          // ── one row per package ──
          pythonOk
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '1px' } },
                packages.map((pkg) => {
                  const acting = busy === pkg.importName;
                  const thisActive = acting && running;
                  const done = job?.done_flag && job?.scope?.includes(pkg.pipName);
                  const failed = done === false && job?.phase === 'error'
                    && job?.scope?.includes(pkg.pipName);

                  return h('div', {
                    key: pkg.importName,
                    style: {
                      display: 'grid',
                      gridTemplateColumns: '14px minmax(0,1fr) 78px 62px auto',
                      gap: '9px', alignItems: 'center',
                      padding: '7px 6px', borderRadius: 'var(--r-xs)',
                      background: thisActive ? 'var(--accent-soft)' : 'transparent',
                    },
                  },
                    // status dot
                    h('span', {
                      className: 'rea-hdot',
                      style: {
                        background: pkg.present ? 'var(--up)'
                          : failed ? 'var(--down)' : 'var(--ink-4)',
                        boxShadow: 'none',
                        width: '6px', height: '6px',
                      },
                    }),

                    // name + purpose
                    h('div', { style: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: '1px' } },
                      h('span', {
                        style: {
                          fontFamily: 'var(--mono)', fontSize: '11.5px',
                          fontWeight: 600, color: 'var(--ink-1)',
                        },
                        title: pkg.path ?? pkg.pipName,
                      }, pkg.label),
                      h('span', {
                        style: { fontSize: '9.5px', color: 'var(--ink-4)', lineHeight: '1.4' },
                      }, pkg.purpose)),

                    // version / size
                    h('span', {
                      style: {
                        fontFamily: 'var(--mono)', fontSize: '9.5px',
                        color: 'var(--ink-4)', textAlign: 'right',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      },
                      title: pkg.path ?? '',
                    }, pkg.present
                      ? (pkg.version ?? '已装')
                      : '~' + pkg.sizeMb + ' MB'),

                    // used-by
                    h('span', {
                      style: {
                        fontFamily: 'var(--mono)', fontSize: '9px',
                        color: 'var(--ink-4)', textAlign: 'right',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      },
                      title: pkg.usedBy.join(', '),
                    }, pkg.usedBy.length + ' 脚本'),

                    // action
                    thisActive
                      ? h('span', {
                          style: {
                            fontFamily: 'var(--mono)', fontSize: '9.5px',
                            color: 'var(--accent)', minWidth: '52px', textAlign: 'right',
                          },
                        }, (job?.percent ?? 0) + '%')
                      : h('button', {
                          type: 'button',
                          className: 'rea-btn rea-btn-sm' + (pkg.present ? ' rea-btn-ghost' : ' rea-btn-primary'),
                          disabled: Boolean(busy),
                          style: { minWidth: '52px', justifyContent: 'center' },
                          onClick: () => onAction(pkg.importName, pkg.present ? 'uninstall' : 'install'),
                        }, pkg.present ? '卸载' : '安装'),
                  );
                }))
            : null,

          // ── active job progress ──
          running
            ? h('div', { style: { marginTop: '10px' } },
                h('div', {
                  style: {
                    display: 'flex', alignItems: 'center', gap: '8px',
                    fontSize: '10.5px', marginBottom: '5px',
                  },
                },
                  h('span', { style: { color: 'var(--accent)', fontWeight: 700 } }, phaseLabel),
                  h('span', {
                    style: { marginLeft: 'auto', fontFamily: 'var(--mono)', color: 'var(--ink-3)' },
                  }, (job?.done ?? 0) + ' / ' + (job?.total ?? 1) + ' · ' + (job?.percent ?? 0) + '%')),
                h('div', { className: 'rea-prog' },
                  h('i', { style: { width: (job?.percent ?? 0) + '%' } })),
                h('div', { style: { display: 'flex', gap: '6px', marginTop: '8px' } },
                  h('button', {
                    type: 'button',
                    className: 'rea-btn rea-btn-sm rea-btn-ghost',
                    onClick: () => onControl('cancel'),
                  }, '取消')))
            : null,

          // ── error from last job ──
          job?.phase === 'error' && job?.error
            ? h('div', {
                style: {
                  marginTop: '9px', padding: '8px 10px', borderRadius: 'var(--r-xs)',
                  background: 'var(--down-soft)', fontSize: '10px',
                  fontFamily: 'var(--mono)', color: 'var(--ink-2)',
                  whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  maxHeight: '130px', overflow: 'auto', lineHeight: '1.55',
                },
              }, job.error.slice(0, 700))
            : null,

          // ── which mirror served the last run ──
          job?.mirror
            ? h('div', {
                style: {
                  marginTop: '6px', fontSize: '9.5px', color: 'var(--ink-4)',
                  fontFamily: 'var(--mono)',
                },
              }, '源：' + (job.mirror.label ?? job.mirror.url)
                + (job.mirror.measuredMs ? ' · ' + job.mirror.measuredMs + 'ms' : ''))
            : null,

          // ── install all ──
          pythonOk && missing.length > 0 && !running
            ? h('div', {
                style: {
                  display: 'flex', alignItems: 'center', gap: '9px',
                  marginTop: '11px', paddingTop: '10px',
                  borderTop: '1px solid var(--border)',
                },
              },
                h('span', {
                  style: { fontSize: '10.5px', color: 'var(--ink-3)' },
                }, '缺 ' + missing.length + ' 个 · 共约 ' + missingMb + ' MB'),
                h('button', {
                  type: 'button',
                  className: 'rea-btn rea-btn-sm rea-btn-primary',
                  disabled: Boolean(busy),
                  style: { marginLeft: 'auto' },
                  onClick: onInstallAll,
                }, busy ? '安装中…' : '全部安装'))
            : null,

          // ── all good ──
          pythonOk && missing.length === 0
            ? h('div', {
                style: {
                  marginTop: '10px', fontSize: '10.5px', color: 'var(--up)',
                  display: 'flex', alignItems: 'center', gap: '6px',
                },
              }, h('span', null, '✓'), h('span', null, '7 个依赖全部就绪'))
            : null));
    }
    function EnginesPage({ status, jobs, log, logError, onInstall, onUninstall, onControl, reloadHint, jdk, jdkBusy, installJdkNow, uninstallJdkNow, pyList, pyJob, pyBusy, runPyAction, installAllPy, controlPy }) {
      const engines = status?.providers ?? [];

      return h('div', null,
        reloadHint
          ? h('div', { className: 'rea-hint' },
              h('span', { 'aria-hidden': true }, 'ℹ'),
              h('span', null,
                '引擎已安装并配置好路径。重启 Harness 或重新加载 ',
                h('code', null, 'rea-mcp'),
                ' 行后，REA 的工具即可使用新引擎。'))
          : null,

        h('div', { className: 'rea-engines' },
          engines.map((entry) => h(EngineCard, {
            key: entry.id,
            entry,
            progress: jobs?.[entry.id] ?? null,
            busy: Boolean(jobs?.[entry.id]),
            paused: Boolean(jobs?.[entry.id]?.paused),
            failed: jobs?.[entry.id]?.error ?? null,
            onInstall,
            onUninstall,
            onControl,
          }))),

        h('div', { className: 'rea-sec-label', style: { marginTop: '16px' } }, '运行时'),
        h(JdkCard, {
          jdk,
          busy: jdkBusy,
          onInstall: installJdkNow,
          onUninstall: uninstallJdkNow,
        }),

        h('div', { className: 'rea-sec-label', style: { marginTop: '16px' } }, '移动端工具链'),
        h(PythonCard, {
          python: pyList?.python ?? status?.python,
          list: pyList,
          job: pyJob,
          busy: pyBusy,
          onAction: runPyAction,
          onInstallAll: installAllPy,
          onControl: controlPy,
        }),

        h('div', { className: 'rea-sec-label', style: { marginTop: '16px' } }, '环境变量'),
        h('div', { className: 'rea-card' },
          h('div', { className: 'rea-card-bd', style: { padding: '11px 14px' } },
            Object.keys(status?.environment ?? {}).length === 0
              ? h('div', { className: 'rea-kpi-foot' }, '暂无已生效的引擎环境变量')
              : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '7px' } },
                  Object.entries(status.environment).map(([key, value]) =>
                    h('div', {
                      key,
                      style: { display: 'flex', gap: '10px', fontFamily: 'var(--mono)', fontSize: '10.5px' },
                    },
                      h('span', { style: { color: 'var(--ink-3)', minWidth: '150px' } }, key),
                      h('span', { style: { color: 'var(--ink-1)', wordBreak: 'break-all' } }, value)))))),

        log
          ? h('div', { style: { marginTop: '13px' } },
              h('div', { className: 'rea-sec-label' }, '最近一次操作'),
              h('pre', { className: `rea-log${logError ? ' rea-log-err' : ''}` }, log))
          : null,
      );
    }

    /** Targets: what REA can analyse right now, and what would change that. */
    function TargetsPage({ status }) {
      const targets = status?.targets ?? [];
      const ready = targets.filter((target) => target.ready).length;
      const blocked = targets.filter((target) => target.blocked === true).length;
      const reachable = targets.length - blocked;

      const CATEGORIES = [
        ['原生分析', 58], ['Android', 34], ['JavaScript', 22], ['托管代码', 19],
        ['动态调试', 24], ['固件', 12], ['网络抓包', 18], ['样本与证据', 20],
      ];

      return h('div', null,
        h('div', { className: 'rea-sec-label' }, '可分析的目标类型'),
        h('div', { className: 'rea-tgt-head' },
          h('div', null,
            h('b', null, `${ready} / ${reachable}`),
            h('span', { className: 'rea-tgt-note' }, '可用')),
          blocked > 0
            ? h('span', { className: 'rea-tgt-note' },
                `${blocked} 项受平台限制，不计入分母`)
            : null),

        h('div', { className: 'rea-targets' },
          targets.map((target) => {
            const isBlocked = target.blocked === true;
            return h('div', {
              key: target.family,
              className: `rea-tgt${isBlocked ? ' rea-tgt-blocked' : ''}`,
            },
              h('div', { className: 'rea-tgt-hd' },
                h('span', {
                  className: 'rea-tgt-dot',
                  style: {
                    background: target.ready
                      ? 'var(--up)'
                      : (isBlocked ? 'var(--ink-4)' : 'var(--warn)'),
                  },
                }),
                h('b', null, target.label),
                h('span', {
                  className: `rea-tgt-engine${isBlocked ? ' rea-tgt-engine-off' : ''}`,
                }, target.engine ?? '—')),
              target.formats
                ? h('span', { className: 'rea-tgt-fmt' }, target.formats)
                : null,
              h('span', { className: 'rea-tgt-tool', title: target.note ?? '' },
                target.ready
                  ? (target.tool ?? `通过 ${target.engine}`)
                  : (target.note ?? (target.fixableBy
                      ? `安装 ${target.fixableBy} 后可分析`
                      : `需要 ${target.engine}`))));
          })),

        h('div', { className: 'rea-sec-label', style: { marginTop: '20px' } }, '工具分类'),
        h('div', { className: 'rea-cols-3' },
          [0, 1, 2].map((column) => h('div', { key: column, className: 'rea-card' },
            h('div', { className: 'rea-card-bd', style: { padding: '12px 14px' } },
              column === 2
                ? h('div', null,
                    h('div', { className: 'rea-sec-label', style: { marginBottom: '7px' } }, '合计'),
                    h('div', { className: 'rea-kpi-value', style: { fontSize: '22px' } },
                      String(status?.toolCount ?? 0),
                      h('small', null, ' 个工具')),
                    h('div', {
                      className: 'rea-kpi-foot',
                      style: { marginTop: '4px', lineHeight: '1.6' },
                    },
                      status?.toolBreakdown
                        ? `REA ${status.toolBreakdown.rea} · 移动端 ${status.toolBreakdown.mobile} · 本地 ${status.toolBreakdown.local}`
                        : (status?.toolCount ? '全部已注册' : '未连接')))
                : CATEGORIES.slice(column * 4, column * 4 + 4).map(([label, count]) =>
                    h('div', { key: label, className: 'rea-cat-row' },
                      h('span', null, label),
                      h('b', { className: 'num' }, String(count)))))))),
      );
    }

    // -----------------------------------------------------------------------
    // The workbench
    // -----------------------------------------------------------------------

    const TABS = [
      { key: 'overview', label: '总览', icon: Icon.grid },
      { key: 'stream', label: '实时流', icon: Icon.wave },
      { key: 'errors', label: '错误', icon: Icon.alert },
      { key: 'health', label: '服务状态', icon: Icon.chart },
      { key: 'engines', label: '引擎', icon: Icon.wrench },
      { key: 'targets', label: '能力', icon: Icon.target },
    ];

    function ReaWorkbench() {
      const [status, setStatus] = useState(null);
      const [statusError, setStatusError] = useState(null);
      const [tab, setTab] = useState('overview');

      // Engine jobs, keyed by engine id.
      const [jobs, setJobs] = useState({});
      const [log, setLog] = useState(null);
      const [logError, setLogError] = useState(false);
      const [reloadHint, setReloadHint] = useState(false);

      // Monitoring.
      const [health, setHealth] = useState(null);
      const [metrics, setMetrics] = useState(null);
      const [stream, setStream] = useState([]);
      const [streamFilter, setStreamFilter] = useState('all');
      const [streamPaused, setStreamPaused] = useState(false);
      const [streamDown, setStreamDown] = useState(false);
      const [selected, setSelected] = useState(null);

      const mounted = useRef(true);
      const pollTimer = useRef(null);
      const sourceRef = useRef(null);
      const streamPausedRef = useRef(false);
      const jobIds = useRef({});

      useEffect(() => { streamPausedRef.current = streamPaused; }, [streamPaused]);

      useEffect(() => () => {
        mounted.current = false;
        if (pollTimer.current) clearTimeout(pollTimer.current);
        sourceRef.current?.close();
      }, []);

      // ---- status ---------------------------------------------------------
      const loadStatus = useCallback(async () => {
        try {
          const response = await fetch(API.status, { headers: { accept: 'application/json' } });
          if (response.status === 404) {
            throw new Error('工作台 API 未注册（404）：插件 Host 半边没有挂到 webServer 上，重启 DSH 后重试');
          }
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const body = await response.json();
          if (!mounted.current) return;
          setStatus(body);
          setStatusError(null);
        } catch (error) {
          if (!mounted.current) return;
          setStatusError(error?.message ?? String(error));
        }
      }, []);

      useEffect(() => { loadStatus(); }, [loadStatus]);

      const [mcpBusy, setMcpBusy] = useState(false);


      const [mcpError, setMcpError] = useState(null);

      // ---- monitoring -----------------------------------------------------
      const loadMonitoring = useCallback(async () => {
        try {
          const [healthResponse, metricsResponse] = await Promise.all([
            fetch(API.health, { headers: { accept: 'application/json' } }),
            fetch(`${API.metrics}?limit=${STREAM_LIMIT}`, { headers: { accept: 'application/json' } }),
          ]);
          if (!mounted.current) return;
          if (healthResponse.ok) setHealth(await healthResponse.json());
          if (metricsResponse.ok) setMetrics(await metricsResponse.json());
        } catch {
          // The stream's own indicator covers a dead Host.
        }
      }, []);

      // ---- Update check ----------------------------------------------------
      const [update, setUpdate] = useState(null);
      const [updateBusy, setUpdateBusy] = useState(false);

      /**
       * Ask once on open, then only when the user presses refresh.
       *
       * The Host caches the registry answer for six hours, so a poll here would
       * cost nothing — but it would also never change, and a notice that appears
       * on its own schedule is noise.
       */
      const checkUpdate = useCallback(async (force = false) => {
        if (updateBusy) return;
        setUpdateBusy(true);
        try {
          const response = await fetch(
            API.update + (force ? "?force=1" : ""),
            { headers: { accept: "application/json" } },
          );
          const body = await response.json();
          if (!mounted.current || !response.ok || !body.ok) return;
          setUpdate(body);
        } catch {
          // Offline is not an error worth showing; the banner simply stays hidden.
        } finally {
          if (mounted.current) setUpdateBusy(false);
        }
      }, [updateBusy]);

      useEffect(() => { checkUpdate(false); }, [checkUpdate]);

      /**
       * Pull the plugin forward, in place.
       *
       * The old banner told the user to open a terminal and run `git pull`.
       * Most people do not, and the ones who do often run it in the wrong
       * directory. The Host can do it correctly — it knows the package root and
       * can refuse a dirty tree — so the button does it and reports what
       * happened.
       *
       * Nothing here restarts DSH. The new files are on disk; loading them is
       * the next launch. `restartRequired` in the result is what the button
       * turns into a visible instruction, because a silent "done" followed by no
       * change is the worst possible outcome.
       */
      const [selfUpdate, setSelfUpdate] = useState(null);
      const [selfUpdating, setSelfUpdating] = useState(false);

      const runUpdate = useCallback(async () => {
        if (selfUpdating) return;
        setSelfUpdating(true);
        try {
          const response = await fetch(API.selfUpdate, {
            method: 'POST',
            headers: { accept: 'application/json' },
          });
          const body = await response.json();
          if (!mounted.current) return;
          setSelfUpdate(body);
          // A finished pull changes the version the banner was reporting, so
          // refresh the check instead of leaving a stale "behind N commits".
          if (body?.phase === 'done') checkUpdate(true);
        } catch (error) {
          if (mounted.current) {
            setSelfUpdate({
              ok: false,
              phase: 'failed',
              error: error?.message ?? String(error),
            });
          }
        } finally {
          if (mounted.current) setSelfUpdating(false);
        }
      }, [selfUpdating, checkUpdate]);

      // ---- JDK 21 (required by Ghidra) ------------------------------------
      const [jdk, setJdk] = useState(null);
      const [jdkBusy, setJdkBusy] = useState(false);
      const jdkTimer = useRef(null);

      const stopJdkPolling = useCallback(() => {
        if (jdkTimer.current) {
          clearTimeout(jdkTimer.current);
          jdkTimer.current = null;
        }
      }, []);

      const loadJdk = useCallback(async () => {
        try {
          const response = await fetch(API.jdk, { headers: { accept: "application/json" } });
          const body = await response.json();
          if (!mounted.current || !response.ok || !body.ok) return;
          setJdk(body);
          return body;
        } catch {
          return null;
        }
      }, []);

      useEffect(() => { loadJdk(); }, [loadJdk]);

      const pollJdk = useCallback(async () => {
        const body = await loadJdk();
        if (!mounted.current) return;
        const job = body?.job;
        if (job && !job.done) {
          jdkTimer.current = setTimeout(pollJdk, 600);
        } else {
          setJdkBusy(false);
          // A finished JDK install may unlock Ghidra, so re-read readiness.
          loadStatus();
        }
      }, [loadJdk, loadStatus]);

      const installJdkNow = useCallback(async () => {
        if (jdkBusy) return;
        setJdkBusy(true);
        try {
          const response = await fetch(API.jdkInstall, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          });
          const body = await response.json();
          if (!mounted.current) return;
          if (!response.ok || !body.ok) { setJdkBusy(false); return; }
          pollJdk();
        } catch {
          if (mounted.current) setJdkBusy(false);
        }
      }, [jdkBusy, pollJdk]);

      const uninstallJdkNow = useCallback(async () => {
        try {
          await fetch(API.jdkUninstall, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          });
          if (!mounted.current) return;
          await loadJdk();
          await loadStatus();
        } catch {
          // The next poll shows the real state.
        }
      }, [loadJdk, loadStatus]);

      useEffect(() => () => stopJdkPolling(), [stopJdkPolling]);

      // ---- Python dependencies (per package) -----------------------------
      const [pyList, setPyList] = useState(null);
      const [pyJob, setPyJob] = useState(null);
      const [pyBusy, setPyBusy] = useState(null);   // importName being acted on
      const pyTimer = useRef(null);

      const stopPyPolling = useCallback(() => {
        if (pyTimer.current) {
          clearTimeout(pyTimer.current);
          pyTimer.current = null;
        }
      }, []);

      /** Read the per-package inventory. */
      const loadPyPackages = useCallback(async () => {
        try {
          const response = await fetch(API.pythonPackages, { headers: { accept: "application/json" } });
          const body = await response.json();
          if (!mounted.current || !response.ok || !body.ok) return;
          setPyList(body);
        } catch {
          // The panel keeps the previous list; the job poll reports the failure.
        }
      }, []);

      useEffect(() => { loadPyPackages(); }, [loadPyPackages]);

      const pollPyJob = useCallback(async (jobId) => {
        try {
          const response = await fetch(API.pythonJob + "?id=" + encodeURIComponent(jobId), {
            headers: { accept: "application/json" },
          });
          const body = await response.json();
          if (!mounted.current) return;
          if (!response.ok || !body.ok) { setPyBusy(null); return; }

          setPyJob(body);

          if (body.done_flag) {
            setPyBusy(null);
            await loadPyPackages();
            await loadStatus();
            await loadMonitoring();
            return;
          }
          pyTimer.current = setTimeout(() => pollPyJob(jobId), 500);
        } catch {
          if (mounted.current) setPyBusy(null);
        }
      }, [loadPyPackages, loadStatus, loadMonitoring]);

      /**
       * Install or remove ONE package.
       *
       * Per-package on purpose: when a single wheel fails to build, the user
       * needs the failure isolated, not a seven-package retry.
       */
      const runPyAction = useCallback(async (importName, action) => {
        if (pyBusy) return;
        setPyBusy(importName);
        setPyJob(null);
        try {
          const response = await fetch(API.pythonInstall, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ only: [importName], action }),
          });
          const body = await response.json();
          if (!mounted.current) return;

          if (!response.ok || !body.ok) {
            setPyJob({ phase: "error", error: body.error ?? "HTTP " + response.status });
            setPyBusy(null);
            return;
          }
          if (body.nothingToDo) {
            setPyBusy(null);
            await loadPyPackages();
            return;
          }
          pollPyJob(body.jobId);
        } catch (error) {
          if (!mounted.current) return;
          setPyJob({ phase: "error", error: error?.message ?? String(error) });
          setPyBusy(null);
        }
      }, [pyBusy, pollPyJob, loadPyPackages]);

      /** Install every missing package in one pip run. */
      const installAllPy = useCallback(async () => {
        if (pyBusy) return;
        const missing = (pyList?.packages ?? []).filter((p) => !p.present).map((p) => p.importName);
        if (missing.length === 0) return;
        setPyBusy("__all__");
        setPyJob(null);
        try {
          const response = await fetch(API.pythonInstall, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ only: missing, action: "install" }),
          });
          const body = await response.json();
          if (!mounted.current) return;
          if (!response.ok || !body.ok) {
            setPyJob({ phase: "error", error: body.error ?? "HTTP " + response.status });
            setPyBusy(null);
            return;
          }
          pollPyJob(body.jobId);
        } catch (error) {
          if (!mounted.current) return;
          setPyJob({ phase: "error", error: error?.message ?? String(error) });
          setPyBusy(null);
        }
      }, [pyBusy, pyList, pollPyJob]);

      const controlPy = useCallback(async (action) => {
        try {
          await fetch(API.pythonControl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action }),
          });
        } catch {
          // The job poll reports the real state.
        }
      }, []);

      useEffect(() => () => stopPyPolling(), [stopPyPolling]);

      /**
       * Start the MCP bridge from the UI.
       *
       * The Host already tries once at load; this exists for the case that
       * attempt lost — no network at boot, a cold npx cache, a transient npx
       * failure. Without it the only fix would be restarting the Host, which is
       * exactly the "configure it yourself" outcome this panel is avoiding.
       */
      const startMcp = useCallback(async () => {
        if (mcpBusy) return;
        setMcpBusy(true);
        setMcpError(null);
        try {
          const response = await fetch(API.mcpStart, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          });
          const body = await response.json();
          if (!mounted.current) return;

          if (!response.ok || !body.ok) {
            setMcpError(body.error ?? `HTTP ${response.status}`);
            return;
          }
          // The registry changed, so the tool count and the target matrix are
          // both stale now.
          await loadStatus();
          await loadMonitoring();
        } catch (error) {
          if (mounted.current) setMcpError(error?.message ?? String(error));
        } finally {
          if (mounted.current) setMcpBusy(false);
        }
      }, [mcpBusy, loadStatus, loadMonitoring]);

      // While the bridge is bootstrapping, poll faster: the handshake takes a
      // couple of seconds and a slower cadence would make it look stuck.
      const mcpState = status?.mcp?.state ?? 'unknown';
      useEffect(() => {
        if (mcpState !== 'starting' && mcpState !== 'idle') return undefined;
        const timer = setInterval(loadStatus, 1500);
        return () => clearInterval(timer);
      }, [mcpState, loadStatus]);

      const openStream = useCallback(() => {
        if (typeof EventSource === 'undefined') {
          setStreamDown(true);
          return;
        }
        sourceRef.current?.close();

        const source = new EventSource(`${API.events}?stream=1`);
        sourceRef.current = source;

        source.onopen = () => { if (mounted.current) setStreamDown(false); };

        source.onmessage = (event) => {
          if (!mounted.current || streamPausedRef.current) return;
          let row;
          try {
            row = JSON.parse(event.data);
          } catch {
            return;
          }
          setStream((current) => {
            const next = [row, ...current];
            return next.length > STREAM_LIMIT ? next.slice(0, STREAM_LIMIT) : next;
          });
        };

        source.onerror = () => {
          // EventSource retries on its own; surface the gap rather than
          // pretending the feed is live.
          if (mounted.current) setStreamDown(true);
        };
      }, []);

      useEffect(() => {
        loadMonitoring();
        openStream();
        return () => { sourceRef.current?.close(); };
      }, [loadMonitoring, openStream]);

      // Re-probe only while the tab that shows the data is visible, so an idle
      // Host is not woken every few seconds for nothing.
      useEffect(() => {
        if (tab !== 'health' && tab !== 'errors') return undefined;
        const timer = setInterval(
          loadMonitoring,
          tab === 'health' ? HEALTH_POLL_MS : METRICS_POLL_MS,
        );
        return () => clearInterval(timer);
      }, [tab, loadMonitoring]);

      // ---- jobs -----------------------------------------------------------
      const pollJob = useCallback(async (engineId) => {
        const jobId = jobIds.current[engineId];
        if (!jobId) return;

        try {
          const response = await fetch(`${API.job}?id=${encodeURIComponent(jobId)}`, {
            headers: { accept: 'application/json' },
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const body = await response.json();
          if (!mounted.current) return;

          setJobs((current) => ({ ...current, [engineId]: body }));

          if (body.done || body.error || body.cancelled) {
            delete jobIds.current[engineId];
            // A finished install changes what the Host can do, so re-read both
            // the readiness matrix and the health checks.
            loadStatus();
            loadMonitoring();
            if (body.done) setReloadHint(true);
            if (body.error) {
              setLog(body.error);
              setLogError(true);
            }
            return;
          }

          pollTimer.current = setTimeout(() => pollJob(engineId), POLL_MS);
        } catch (error) {
          if (!mounted.current) return;
          setLog(error?.message ?? String(error));
          setLogError(true);
        }
      }, [loadStatus, loadMonitoring]);

      const startInstall = useCallback(async (engineId) => {
        setLog(null);
        setLogError(false);
        try {
          const response = await fetch(API.install, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ only: [engineId] }),
          });
          const body = await response.json();
          if (!response.ok || !body.ok) throw new Error(body.error ?? `HTTP ${response.status}`);

          if (!mounted.current) return;
          jobIds.current[engineId] = body.jobId;
          setJobs((current) => ({
            ...current,
            [engineId]: { phase: 'pending', received: 0, total: 0, done: false },
          }));
          pollTimer.current = setTimeout(() => pollJob(engineId), POLL_MS);
        } catch (error) {
          if (!mounted.current) return;
          setLog(error?.message ?? String(error));
          setLogError(true);
        }
      }, [pollJob]);

      const controlJob = useCallback(async (engineId, action) => {
        const jobId = jobIds.current[engineId];
        if (!jobId) return;
        try {
          const response = await fetch(API.control, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: jobId, action }),
          });
          const body = await response.json();
          if (!response.ok || !body.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
          if (!mounted.current) return;
          setJobs((current) => ({ ...current, [engineId]: body.job ?? current[engineId] }));
          if (action === 'cancel') delete jobIds.current[engineId];
        } catch (error) {
          if (!mounted.current) return;
          setLog(error?.message ?? String(error));
          setLogError(true);
        }
      }, []);

      const uninstall = useCallback(async (engineId) => {
        setLog(null);
        setLogError(false);
        try {
          // Preview first: the Host refuses paths outside its cache root, and a
          // user should see what is about to be deleted before it happens.
          const previewResponse = await fetch(
            `${API.uninstallPreview}?id=${encodeURIComponent(engineId)}`,
            { headers: { accept: 'application/json' } },
          );
          const preview = await previewResponse.json();
          if (!previewResponse.ok || !preview.ok) {
            throw new Error(preview.error ?? `HTTP ${previewResponse.status}`);
          }

          const response = await fetch(API.uninstall, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ only: [engineId], confirm: true }),
          });
          const body = await response.json();
          if (!response.ok || !body.ok) throw new Error(body.error ?? `HTTP ${response.status}`);

          if (!mounted.current) return;
          setLog(
            `已卸载 ${engineId}，释放 ${formatBytes(preview.freedBytes ?? body.freedBytes ?? 0)}。`
            + (body.restartRequired ? '\n重启 Harness 后生效。' : ''),
          );
          loadStatus();
          loadMonitoring();
        } catch (error) {
          if (!mounted.current) return;
          setLog(error?.message ?? String(error));
          setLogError(true);
        }
      }, [loadStatus, loadMonitoring]);

      const resetMetrics = useCallback(async () => {
        try {
          await fetch(API.metricsReset, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ clearEntries: true }),
          });
          if (!mounted.current) return;
          setStream([]);
          setSelected(null);
          await loadMonitoring();
        } catch {
          // The next refresh shows the real state.
        }
      }, [loadMonitoring]);

      // ---- derived --------------------------------------------------------
      const counts = metrics?.counts ?? {};
      const errorTotal = counts.failed ?? 0;
      const healthErrors = (health?.checks ?? []).filter((check) => check.status === 'error').length;
      const healthWarns = (health?.checks ?? []).filter((check) => check.status === 'warn').length;
      const missingEngines = (status?.providers ?? []).filter((entry) => !entry.present).length;
      const runningJobs = Object.keys(jobs).filter(
        (key) => jobs[key] && !jobs[key].done && !jobs[key].error && !jobs[key].cancelled,
      ).length;
      const serverUp = Boolean(status) && !statusError;

      const badges = {
        overview: null,
        stream: streamDown ? '!' : (stream.length > 0 ? String(stream.length) : null),
        errors: errorTotal > 0 ? String(errorTotal) : null,
        health: healthErrors + healthWarns > 0 ? String(healthErrors + healthWarns) : null,
        engines: runningJobs > 0 ? String(runningJobs) : (missingEngines > 0 ? String(missingEngines) : null),
        targets: null,
      };
      const badgeTones = {
        errors: 'err',
        health: healthErrors > 0 ? 'err' : 'warn',
        engines: runningJobs > 0 ? 'warn' : 'warn',
        stream: streamDown ? 'err' : null,
      };

      // ---- first paint ----------------------------------------------------
      if (!status && !statusError) {
        return h('div', { className: 'rea-wb' },
          h(Styles),
          h('div', { className: 'rea-scroll' },
            h('div', { className: 'rea-card' },
              h(Empty, {
                icon: Icon.wrench,
                title: '正在读取工作台状态…',
                body: '探测分析引擎与目标类型',
              }))));
      }

      if (statusError && !status) {
        return h('div', { className: 'rea-wb' },
          h(Styles),
          h('div', { className: 'rea-scroll' },
            h('div', { className: 'rea-card', style: { borderColor: 'rgba(194,46,34,.28)' } },
              h(Empty, {
                icon: Icon.alert,
                title: '无法连接 Host',
                body: statusError,
              }),
              h('div', { style: { padding: '0 20px 20px', textAlign: 'center' } },
                h('button', {
                  type: 'button',
                  className: 'rea-btn rea-btn-primary',
                  onClick: loadStatus,
                }, '重试')))));
      }

      const avg = formatShortDuration(counts.avgMs ?? null);

      return h('div', { className: 'rea-wb' },
        h(Styles),

        h('header', { className: 'rea-topnav' },
          h('div', { className: 'rea-brand' },
            h('div', { className: 'rea-mk' }, 'REA'),
            h('b', null, '逆向工作台'),
            h('span', {
              className: `rea-pulse${serverUp ? '' : ' rea-pulse-down'}`,
              title: serverUp ? 'Host 已连接' : 'Host 未连接',
            })),

          h('nav', { className: 'rea-tabs', role: 'tablist' },
            TABS.map((entry) => {
              const badge = badges[entry.key];
              const tone = badgeTones[entry.key];
              return h('button', {
                key: entry.key,
                type: 'button',
                role: 'tab',
                'aria-selected': tab === entry.key,
                className: `rea-tab${tab === entry.key ? ' rea-tab-on' : ''}`,
                onClick: () => setTab(entry.key),
              },
                entry.icon(),
                h('span', { className: 'rea-tab-label' }, entry.label),
                badge !== null && badge !== undefined
                  ? h('span', {
                      className: `rea-tab-bdg${tone ? ` rea-tab-bdg-${tone}` : ''}`,
                    }, badge)
                  : null);
            })),

          h('div', { className: 'rea-tb-right' },
            h('span', { className: 'rea-stat' },
              '调用 ', h('b', { className: 'num' }, String(counts.total ?? 0))),
            h('span', { className: 'rea-stat' },
              '异常 ', h('b', { className: 'num down' }, String(errorTotal))),
            h('span', { className: 'rea-stat rea-stat-hide' },
              '平均 ', h('b', { className: 'num' }, `${avg.value}${avg.unit}`)),
            h('span', { className: 'rea-tb-div' }),
            h(UpdateButton, {
              update,
              result: selfUpdate,
              busy: selfUpdating,
              onRun: runUpdate,
            }),
            h('a', {
              className: 'rea-btn rea-btn-sm rea-btn-ghost rea-btn-icon',
              href: 'https://github.com/jiuyou-7411/dsh-rea-plugin',
              target: '_blank',
              rel: 'noopener noreferrer',
              title: '在 GitHub 上查看源码与更新',
              'aria-label': 'GitHub 仓库',
            }, Icon.github()),
            h('button', {
              type: 'button',
              className: 'rea-btn rea-btn-sm rea-btn-primary',
              onClick: () => setTab('engines'),
            }, Icon.upload(), h('span', { className: 'rea-btn-label' }, '引擎')),
            h('button', {
              type: 'button',
              className: 'rea-btn rea-btn-sm rea-btn-ghost',
              title: '刷新状态',
              onClick: () => { loadStatus(); loadMonitoring(); loadPyPackages(); loadJdk(); },
            }, Icon.refresh()))),

        h('div', { className: 'rea-scroll' },
          tab === 'overview'
            ? h(OverviewPage, {
                status,
                metrics,
                health,
                mcpBusy,
                mcpError,
                onStartMcp: startMcp,
                onGo: setTab,
                update,
                onCheckUpdate: () => checkUpdate(true),
                updateBusy,
              })
            : null,

          tab === 'stream'
            ? h(StreamPage, {
                stream,
                filter: streamFilter,
                onFilter: setStreamFilter,
                paused: streamPaused,
                onTogglePause: () => setStreamPaused((current) => !current),
                onClear: () => { setStream([]); setSelected(null); },
                serverDown: streamDown,
                selected,
                onSelect: setSelected,
              })
            : null,

          tab === 'errors'
            ? h(ErrorsPage, { metrics, onReset: resetMetrics })
            : null,

          tab === 'health'
            ? h(HealthPage, { health })
            : null,

          tab === 'engines'
            ? h(EnginesPage, {
                status,
                jobs,
                log,
                logError,
                reloadHint,
                jdk,
                jdkBusy,
                installJdkNow,
                uninstallJdkNow,
                pyList,
                pyJob,
                pyBusy,
                runPyAction,
                installAllPy,
                controlPy,
                onInstall: startInstall,
                onUninstall: uninstall,
                onControl: controlJob,
              })
            : null,

          tab === 'targets'
            ? h(TargetsPage, { status })
            : null),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // The icon and the panel share one id, so the sidebar entry addresses
        // this exact main key.
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 40,
          label: () => 'REA',
        }, SidebarIcon));

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
        }, ReaWorkbench));
      },
    };
  },
});

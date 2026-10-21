/**
 * Plain-Chinese explanations for the errors this plugin reports.
 *
 * The panel shows raw tool errors, and those are English by nature: they come
 * from Node, from pip, from an engine's own stderr. Translating them wholesale
 * would destroy the detail that makes them useful — a stack frame or a file path
 * is not language.
 *
 * So this is an *explanation* layer, not a translation: match the message
 * against a known failure, then say in Chinese what happened, why, and what to
 * do. The original text stays beside it, because the one moment a user needs the
 * English is when they search for it.
 *
 * Every entry is a real failure observed in this plugin's code paths or in its
 * dependency chain — nothing speculative.
 */

/**
 * Ordered patterns. First match wins, so put specific patterns before general
 * ones (`EPERM ... rename` before bare `EPERM`).
 */
const RULES = [
  // ---- file and permission ----
  {
    match: /file has not been read|read the file, then retry/i,
    what: '文件还没读过就尝试修改',
    why: '编辑工具要求先读取文件再改，防止覆盖掉你手改的内容。',
    fix: '先打开文件看一眼再改，或者让 Agent 自己先读一次。',
  },
  {
    match: /EPERM.*rename|operation not permitted.*rename/i,
    what: '文件改名被系统拒绝',
    why: 'Windows 在文件还被占用时不允许改名。常见是刚下载完、杀毒软件正在扫描，或者另一个进程正开着它。',
    fix: '等一两秒重试。这个插件已经会自动重试 6 次并降级为复制，仍然失败说明有程序长期占用。',
  },
  {
    match: /EBUSY|resource busy/i,
    what: '文件被占用',
    why: '有另一个程序正打开着这个文件。',
    fix: '关掉可能占用它的程序（杀毒软件、编辑器、另一个 DSH 窗口）后重试。',
  },
  {
    match: /ENOENT|no such file or directory/i,
    what: '找不到文件',
    why: '路径不对，或者文件已被删除、移动。',
    fix: '确认路径存在。如果是插件依赖的引擎文件缺失，到「引擎」页重新安装。',
  },
  {
    match: /EACCES|permission denied/i,
    what: '没有访问权限',
    why: '当前用户无权读写这个位置。',
    fix: '换一个用户有权限的目录，或者用管理员权限运行一次。',
  },
  {
    match: /ENOSPC|no space left/i,
    what: '磁盘空间不足',
    why: '下载或解压需要的空间比剩余空间大。',
    fix: '清理磁盘后重试。Ghidra 解压后约需 1.5 GB。',
  },

  // ---- python (before network: "No module named x" contains no DNS hint,
  //     but a loose getaddrinfo pattern elsewhere could shadow it) ----
  {
    match: /ModuleNotFoundError|No module named/i,
    what: 'Python 依赖缺失',
    why: '某个 Python 包没装，或者装到了另一个 Python 环境里。',
    fix: '到「移动端工具链」区，看哪个包是灰色的，点它右边的「安装」。',
  },
  {
    match: /pip 退出码|所有镜像均失败/i,
    what: 'Python 包装不上',
    why: '所有下载镜像都失败了，通常是网络问题，或者这个包在你的 Python 版本上没有预编译版本。',
    fix: '检查网络后重试。错误详情里会写出每个镜像的具体原因。',
  },
  {
    match: /未找到 Python 解释器|python.*not found/i,
    what: '没有 Python',
    why: '本机没装 Python 3，移动端的 6 个工具依赖它。',
    fix: '安装 Python 3.9 或更高版本后刷新页面。不装也能用其他工具，只是少了动态分析。',
  },

  // ---- network ----
  {
    match: /fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i,
    what: '网络连接失败',
    why: '连不上下载源，可能是网络不通、被防火墙拦截，或者对方服务器临时不可用。',
    fix: '检查网络后重试。插件会自动换下一个下载源；如果全部失败，多半是网络问题。',
  },
  {
    match: /ENOTFOUND|getaddrinfo/i,
    what: '域名解析失败',
    why: 'DNS 查不到这个域名，通常是断网或 DNS 配置有问题。',
    fix: '确认能正常上网（试试打开网页），然后重试。',
  },
  {
    match: /HTTP 40[13]|HTTP 404/i,
    what: '下载源返回错误',
    why: '地址失效（404）或拒绝访问（403）。上游更新版本后旧链接可能失效。',
    fix: '这通常是插件版本旧了。升级插件后重试。',
  },
  {
    match: /HTTP 5\d\d/i,
    what: '下载源服务器出错',
    why: '对方服务器临时故障，不是你这边的问题。',
    fix: '等几分钟重试，插件会自动换源。',
  },
  {
    match: /truncated|下载中断|没有收到数据/i,
    what: '下载中途断开',
    why: '网络不稳定，或者下载源太慢导致长时间没有数据。',
    fix: '重试即可，已下载的部分会保留，从断点继续。',
  },

  // ---- spawn and process ----
  {
    match: /spawn.*ENOENT|command not found|不是内部或外部命令/i,
    what: '找不到要执行的程序',
    why: '需要的命令行工具没装，或者不在 PATH 里。',
    fix: '确认 Node.js 已安装（node -v 能输出版本）。缺分析引擎就到「引擎」页安装。',
  },
  {
    match: /MCP 进程已退出|code=1.*signal=none/i,
    what: 'REA 服务启动后立刻退出',
    why: 'npx 没能下载或启动 rea-agents，常见于首次安装时网络不通。',
    fix: '等它自动重试（共 5 次）。仍失败就检查网络，然后点「重新连接」。',
  },
  {
    match: /timeout|timed out|超时/i,
    what: '操作超时',
    why: '任务运行时间超过了限制。Ghidra 分析大文件本身就很慢。',
    fix: '如果是分析大文件，属于正常情况，等它跑完或缩小分析范围。如果是下载卡住，检查网络后重试。',
  },

  // ---- engines ----
  {
    match: /Ghidra not configured|ghidra.*not.*configured/i,
    what: 'Ghidra 还没安装',
    why: '57 个 native 分析工具都依赖 Ghidra（原生二进制反编译）。',
    fix: '到「引擎」页点 Ghidra 的「一键安装」。装之前要确保 JDK 21 就绪。',
  },
  {
    match: /requires Java 21|java.*21.*or later/i,
    what: 'Java 版本太低',
    why: 'Ghidra 11.2 以后要求 JDK 21，本机可能还是 17 或更低。',
    fix: '到「运行时」区点「安装 JDK 21」。它装在哪只影响这个插件，不改你系统的 Java。',
  },
  {
    match: /jadx|apktool|frida.*not.*found/i,
    what: '分析引擎缺失',
    why: '需要的引擎还没安装。',
    fix: '到「引擎」页安装对应引擎。',
  },

  // ---- install jobs ----
  {
    match: /job-running|job already running/i,
    what: '已有任务在跑',
    why: '同一时间只允许一个安装任务，避免两个进程抢同一个文件。',
    fix: '等当前任务结束，或者先点「取消」。',
  },
  {
    match: /no-active-job|no-job/i,
    what: '没有正在运行的任务',
    why: '任务已经结束，或页面在你操作前刷新过。',
    fix: '刷新页面看最新状态，不需要处理。',
  },
  {
    match: /已取消|已暂停|InstallAborted/i,
    what: '操作已中止',
    why: '你点了取消或暂停，不是错误。',
    fix: '需要的话重新点安装。已下载的部分会保留。',
  },

  // ---- protocol ----
  {
    match: /非法的 rea 子命令|invalid command/i,
    what: '命令名不合法',
    why: '只允许小写字母、数字和连字符。',
    fix: '用 action=commands 查可用的命令名。',
  },
  {
    match: /没有这篇文档|文档正文未随插件分发/i,
    what: '找不到指定文档',
    why: '文档名拼错了，或者插件包不完整。',
    fix: '用 action=index 看全部文档名。如果提示「未随插件分发」，说明插件安装不完整，需要重装。',
  },
  {
    match: /MCP 未连接|not connected/i,
    what: 'REA 服务未连接',
    why: '后台的 rea-agents 没有启动成功。',
    fix: '点顶部横幅的「重新连接」。它本来会自动重试 5 次，还失败就检查网络。',
  },
];

/**
 * Explain one error message.
 *
 * Returns `null` when nothing matches — an unknown error is reported as it
 * arrived rather than forced into a wrong category.
 */
export function explainError(message) {
  const text = String(message ?? '');
  if (!text) return null;

  for (const rule of RULES) {
    if (rule.match.test(text)) {
      return { what: rule.what, why: rule.why, fix: rule.fix };
    }
  }
  return null;
}

/**
 * A short Chinese label for a tool name.
 *
 * The panel showed `mcp__rea__analyze_function` and `win_bash`, which mean
 * nothing to someone who does not already know the tool list.
 */
const TOOL_LABELS = {
  win_bash: '执行命令',
  read: '读文件',
  write: '写文件',
  edit: '修改文件',
  glob: '查找文件',
  grep: '搜索内容',
  present: '展示文件',
  todo_write: '任务清单',
  web_fetch: '抓取网页',
  web_search: '网页搜索',
  ask_user_question: '向用户提问',
  create_skill: '创建技能',
  skill: '加载技能',
  skill_vault: '技能库',
  plugin_manager: '插件管理',
  mcp_vault: 'MCP 管理',
  subagent: '子任务',
  workflow: '工作流',
  schedule_create: '定时任务',
};

/** Chinese label for a tool, falling back to a cleaned-up id. */
export function toolLabel(name) {
  const raw = String(name ?? '');
  if (TOOL_LABELS[raw]) return TOOL_LABELS[raw];

  if (raw.startsWith('mcp__rea__')) {
    return 'REA · ' + raw.slice('mcp__rea__'.length).replace(/_/g, ' ');
  }
  if (raw.startsWith('mobile_')) {
    return '移动端 · ' + raw.slice('mobile_'.length);
  }
  return raw;
}

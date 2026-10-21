#!/usr/bin/env node
/**
 * 发布到 npm 官方源。
 *
 * 为什么需要这个脚本：
 *
 *   1. 这台机器的 npm registry 是 registry.npmmirror.com（淘宝镜像）。
 *      镜像只能下载，不能发布 —— `npm publish` 会失败并报一个和真实原因
 *      无关的错。所以发布时必须显式指定官方源。
 *
 *   2. 登录状态也记在 registry 上。如果用户是在官方源登录的，而当前
 *      registry 是镜像，`npm whoami` 会说未登录，即使 token 就在那儿。
 *      脚本会先检查登录，未登录就告诉用户该跑哪条命令。
 *
 *   3. 发布前跑一遍 verify-package.mjs，缺文件就别发 —— 已发布的版本
 *      撤回很麻烦，包名和版本号会被永久占用。
 *
 * 用法：
 *   node scripts/publish.mjs              # 正式发布
 *   node scripts/publish.mjs --dry-run    # 只演练，不真发
 *   node scripts/publish.mjs --otp 123456 # 带两步验证码
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const REGISTRY = 'https://registry.npmjs.org/';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const otpIndex = args.indexOf('--otp');
const otp = otpIndex >= 0 ? args[otpIndex + 1] : null;

/** 在仓库根目录跑一条命令，返回 stdout。失败时把 stderr 一起抛出来。 */
function run(cmd, cmdArgs, { allowFail = false } = {}) {
  try {
    return execFileSync(cmd, cmdArgs, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    }).trim();
  } catch (error) {
    const stderr = (error.stderr ?? '').toString().trim();
    const stdout = (error.stdout ?? '').toString().trim();
    if (allowFail) return { failed: true, stderr, stdout };
    throw new Error(
      `命令失败: ${cmd} ${cmdArgs.join(' ')}\n${stderr || stdout || error.message}`,
    );
  }
}

function step(title) {
  console.log(`\n\x1b[36m▸ ${title}\x1b[0m`);
}

function ok(message) {
  console.log(`  \x1b[32m✓\x1b[0m ${message}`);
}

function fail(message) {
  console.error(`  \x1b[31m✗\x1b[0m ${message}`);
}

function warn(message) {
  console.log(`  \x1b[33m!\x1b[0m ${message}`);
}

// ─── 1. 读包信息 ──────────────────────────────────────────────────────────

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

console.log(`\x1b[1m发布 ${pkg.name}@${pkg.version}\x1b[0m`);
if (dryRun) console.log('\x1b[33m（演练模式，不会真的发布）\x1b[0m');

// ─── 2. 登录检查 ──────────────────────────────────────────────────────────

step('检查登录状态');

const whoami = run('npm', ['whoami', `--registry=${REGISTRY}`], { allowFail: true });
if (whoami.failed) {
  fail('未登录 npm 官方源');
  console.log(`
  先在这个终端里跑一次登录：

    npm login --registry=${REGISTRY}

  按提示输入用户名、密码、邮箱，再用验证器（或邮件验证码）确认。
  登录后重新运行本脚本。
`);
  process.exit(1);
}
ok(`已登录：${whoami.stdout}`);

// ─── 3. 版本是否已存在 ────────────────────────────────────────────────────

step('检查版本占用');

const existing = run(
  'npm',
  ['view', `${pkg.name}@${pkg.version}`, 'version', `--registry=${REGISTRY}`],
  { allowFail: true },
);
if (!existing.failed && existing.stdout) {
  fail(`${pkg.name}@${pkg.version} 已存在于 npm`);
  console.log(`
  已发布的版本不能覆盖。改版本号后再发：

    npm version patch   # 3.0.4 → 3.0.5
    npm version minor   # 3.0.4 → 3.1.0
`);
  process.exit(1);
}
ok('版本可用');

// ─── 4. 包名是否被别人占用 ────────────────────────────────────────────────

step('检查包名归属');

const owner = run(
  'npm',
  ['view', pkg.name, 'maintainers', '--json', `--registry=${REGISTRY}`],
  { allowFail: true },
);
if (!owner.failed && owner.stdout) {
  try {
    const maintainers = JSON.parse(owner.stdout);
    const names = (Array.isArray(maintainers) ? maintainers : [maintainers])
      .map((m) => m?.name)
      .filter(Boolean);
    if (names.length && !names.includes(whoami.stdout)) {
      fail(`包名 ${pkg.name} 已被 ${names.join(', ')} 占用`);
      process.exit(1);
    }
    ok(`包名归你所有（maintainers: ${names.join(', ')}）`);
  } catch {
    warn('维护者信息解析不出来，跳过');
  }
} else {
  ok('包名未被占用，首次发布');
}

// ─── 5. 打包完整性 ────────────────────────────────────────────────────────

step('检查打包完整性');

try {
  const verify = run('node', ['scripts/verify-package.mjs']);
  const lastLine = verify.split('\n').filter(Boolean).pop() ?? '通过';
  ok(lastLine.replace(/^\s*/, ''));
} catch (error) {
  fail('打包检查未通过');
  console.error(error.message);
  process.exit(1);
}

// ─── 6. 预览产物 ──────────────────────────────────────────────────────────

step('预览将要发布的文件');

const pack = run('npm', ['pack', '--dry-run', `--registry=${REGISTRY}`], {
  allowFail: true,
});
if (!pack.failed) {
  const sizeMatch = pack.stdout.match(/package size:\s*([\d.]+\s*\w+)/);
  const filesMatch = pack.stdout.match(/total files:\s*(\d+)/);
  if (filesMatch) ok(`${filesMatch[1]} 个文件`);
  if (sizeMatch) ok(`压缩后 ${sizeMatch[1]}`);
}

// ─── 7. 发布 ──────────────────────────────────────────────────────────────

if (dryRun) {
  step('演练结束');
  console.log(`
  实际发布请去掉 --dry-run：

    node scripts/publish.mjs
`);
  process.exit(0);
}

step('发布');

const publishArgs = ['publish', `--registry=${REGISTRY}`, '--access', 'public'];
if (otp) publishArgs.push(`--otp=${otp}`);

console.log(`  $ npm ${publishArgs.join(' ')}\n`);

try {
  const out = run('npm', publishArgs);
  if (out) console.log(out);
  ok(`发布成功：${pkg.name}@${pkg.version}`);
  console.log(`
  npm 页面：https://www.npmjs.com/package/${pkg.name}
  安装命令：npm i ${pkg.name}
`);
} catch (error) {
  fail('发布失败');
  console.error(`\n${error.message}\n`);

  // 两步验证是最常见的失败原因，单独给个提示。
  if (/one-time|OTP|EOTP/i.test(error.message)) {
    console.log(`  需要两步验证码，重新运行并附上 6 位数字：

    node scripts/publish.mjs --otp 123456
`);
  }
  process.exit(1);
}

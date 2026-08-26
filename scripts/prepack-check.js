#!/usr/bin/env node
/**
 * ============================================================================
 * prepack-check.js —— 发布前健康检查
 * ============================================================================
 *
 * 【作用】
 *   在 `npm publish` / `npm pack` 之前自动运行（由 package.json 的
 *   "prepack" 脚本触发），逐项检查插件包是否"可发布"。
 *   任何一项失败都会置 exit code 为 1，阻止发布一个坏包。
 *
 * 【检查项】
 *   1. 必需文件是否存在（lib、类型声明、patch、对齐参数）
 *   2. 至少有待机动画的 thumb
 *   3. 原始 1200×1200 母版不得进 npm 包（体积超限，应放 GitHub Releases）
 *   4. client.js 是官方 bundle 形态（__ModuleLoader__.load + exports.apply）
 *   5. package.json 声明了 dsh.bundle 和 dsh.client（否则装不上）
 *   6. 包总大小 < 200MB（自设软上限，防误塞母版；npm 硬上限远更大）
 *
 * 【已知坑】
 * - npm 在打包前于包根目录运行 prepack 脚本（ROOT 按 import.meta.url 解析，与 cwd 无关）；
 * - 大小检查统计的是当前工作区文件（排除 node_modules/.git/scripts/过程目录），
 *   不是 tarball 实际体积——只做数量级防护，误塞大文件主要靠第 3 项母版检查兜底；
 * - 失败只置 exitCode=1、不中断进程：多条失败会一次性全部报出，便于一次修完。
 *
 * ============================================================================
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 包根目录（scripts/ 的上一级）
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
// 失败/通过 的输出辅助
const fail = (msg) => {
  console.error(`[prepack-check] FAIL: ${msg}`);
  process.exitCode = 1;
};
const ok = (msg) => console.log(`[prepack-check] ok: ${msg}`);

// ---- 1. 必需文件存在性 ----
const required = [
  'lib/index.js', // 宿主半侧
  'lib/client.js', // 浏览器半侧
  'lib/types/index.d.ts', // 宿主类型声明
  'lib/types/client/index.d.ts', // 客户端类型声明
  'cordis.patch.yml', // bundle patch（挂载声明）
];
for (const f of required) {
  existsSync(join(ROOT, f)) ? ok(`exists ${f}`) : fail(`missing ${f}`);
}

// ---- 2. 至少有待机动画（播放必需）——webm（默认 latest 发布）或 mov（@hevc 发布）任一存在即可 ----
const idleWebm = join(ROOT, 'assets', 'webm', '待机呼吸休闲.webm');
const idleMov = join(ROOT, 'assets', 'mov', '待机呼吸休闲.mov');
existsSync(idleWebm)
  ? ok('idle webm present')
  : existsSync(idleMov)
    ? ok('idle mov present (@hevc build)')
    : fail('missing 待机呼吸休闲.webm/mov thumb');

// ---- 3. 原始母版不得进 npm 包 ----
// assets/ 根下若有 .webm 就是原始母版（播放素材在 assets/webm|mov 子目录）
const originals = [];
const assetsRoot = join(ROOT, 'assets');
for (const name of readdirSync(assetsRoot)) {
  if (name.endsWith('.webm')) originals.push(name);
}
if (originals.length > 0)
  fail(`original masters must not ship in npm package: ${originals.join(', ')} (move them to GitHub Releases)`);
else ok('no original masters in assets/');

// ---- 4. client.js 必须是官方 bundle 形态（含插件三件套导出） ----
const client = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');
client.includes('__ModuleLoader__.load')
  ? ok('client bundle shell OK')
  : fail('client.js missing __ModuleLoader__.load');
// 兼容两种导出形态：ESM 命名导出（exports.apply/exports.inject/exports.name），
// 或 CJS module.exports 对象字面量（同一对象内含 apply/inject/name 三个键）
const exportsPlugin =
  /exports\.(apply|inject|name)/.test(client) || /module\.exports\s*=\s*\{[^}]*apply[^}]*inject[^}]*name/.test(client);
exportsPlugin ? ok('client exports apply/inject/name') : fail('client.js missing apply/inject/name exports');

// ---- 5. package.json 必须声明 bundle + client ----
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
if (pkg.dsh?.bundle?.patch) ok('dsh.bundle.patch declared');
else fail('package.json missing dsh.bundle.patch');
if (pkg.dsh?.client?.platform === 'web') ok('dsh.client.web declared');
else fail('package.json missing dsh.client platform web');

// ---- 6. 包总大小估算（排除 node_modules/.git/脚本/素材源目录/README预览GIF） ----
let total = 0;
// 递归统计包内文件总字节数（仅作口径自查，不是 tarball 实际大小）
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      // 跳过不会进 npm 包的目录（node_modules/.git/scripts 脚本/step01-03 开发过程目录/preview 预览图）
      if (!['node_modules', '.git', 'scripts', 'step01', 'step02', 'step03', 'preview'].includes(entry.name)) walk(p);
    } else if (!entry.name.endsWith('.map')) {
      // 打包产物 tarball（npm pack 遗留）不计入自查口径
      if (!entry.name.endsWith('.tgz')) total += statSync(p).size; // sourcemap 不计
    }
  }
};
walk(ROOT);
// 200MB 软上限：主要防 1200×1200 原始母版误入（npm 实际硬上限远大于此）
const mb = (total / 1e6).toFixed(1);
if (total > 200e6) fail(`package too large: ${mb}MB (limit 200MB)`);
else ok(`package size ${mb}MB`);

// ---- 汇总 ----
if (process.exitCode) console.error('\n[prepack-check] fix the failures above before publishing.');
else console.log('\n[prepack-check] all checks passed — ready to pack/publish.');

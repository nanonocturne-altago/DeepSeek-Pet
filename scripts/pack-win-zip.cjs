/**
 * Windows 解包目录 → zip 分发包。
 * 用法：node scripts/pack-win-zip.cjs <arch>   （arch: x64 | arm64）
 * - 把 release/win-<arch>-unpacked 压缩为 release/DeepSeekPet-<版本>-win-<arch>.zip
 *   （zip 内顶层文件夹命名为 DeepSeekPet-<版本>-win-<arch>/，解压即见清晰结构）
 * - 复制到 ../pack_output/WIN/
 * 分发形态：解包目录压缩包——下载者解压即可看到完整文件结构（比自解压单 exe 更透明可信），
 * 首次运行会在 exe 同级自动创建 motion/、sound/、data/（绿色便携，零 C 盘污染）。
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const arch = process.argv[2] || 'x64';
const pkg = require('../package.json');
const root = path.join(__dirname, '..');
const release = path.join(root, 'release');
const srcDir = path.join(release, `win-${arch}-unpacked`);
const stageDir = path.join(release, `DeepSeekPet-${pkg.version}-win-${arch}`);
const zipName = `${path.basename(stageDir)}.zip`;
const zipPath = path.join(release, zipName);

if (!fs.existsSync(srcDir)) {
  console.error(`[pack-win-zip] 找不到解包目录: ${srcDir}`);
  process.exit(1);
}

// 暂存为正式名称后再压缩（zip 内顶层文件夹名即正式名）
fs.rmSync(stageDir, { recursive: true, force: true });
fs.cpSync(srcDir, stageDir, { recursive: true });
fs.rmSync(zipPath, { force: true });
execFileSync('ditto', ['-c', '-k', '--keepParent', stageDir, zipPath], { stdio: 'inherit' });
fs.rmSync(stageDir, { recursive: true, force: true });
console.log(`[pack-win-zip] 已生成 ${zipName}`);

const outDir = path.join(root, '..', 'pack_output', 'WIN');
fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(zipPath, path.join(outDir, zipName));
console.log(`[pack-win-zip] 已复制到 ${outDir}`);

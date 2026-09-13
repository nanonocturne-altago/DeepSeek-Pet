// 校验归中功能新代码落位：
// - dist/renderer.js（esbuild 产物，中文是 \uXXXX 转义，用 ASCII 标识检查）
// - electron/preload.cjs / electron/main.cjs（明文 CJS，中文原样保留，可直接查中文）
const fs = require('fs');
const path = require('path');
const rd = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const renderer = rd('dist/renderer.js');
const preload = rd('electron/preload.cjs');
const main = rd('electron/main.cjs');

const checks = [
  ['renderer: 订阅 onCenter', renderer.includes('onCenter')],
  ['renderer: 归中前调 stopMove', renderer.includes('stopMove()')],
  ['preload: onCenter 桥', preload.includes('onCenter')],
  ['preload: pet-center 通道', preload.includes('pet-center')],
  ['preload: 取消订阅', preload.includes('removeListener')],
  ['main: 归中函数', main.includes('centerPetToCursorScreen')],
  ['main: 推送 pet-center', main.includes("send('pet-center'")],
  ['main: 托盘菜单归中项', main.includes('label: \'归中\'')],
  ['main: 托盘归中注释', main.includes('center via tray context menu')],
  ['main: Dock 菜单归中', main.includes('center via dock context menu')],
];
let ok = true;
for (const [name, pass] of checks) {
  console.log((pass ? 'PASS' : 'FAIL') + '  ' + name);
  if (!pass) ok = false;
}
process.exit(ok ? 0 : 1);

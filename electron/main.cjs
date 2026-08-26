/**
 * Electron 主进程：独立版桌宠的窗口外壳。
 *
 * 职责：
 *   1. 启动本地 HTTP 服务（server.cjs，全部 /dsh-pet-7340 路由）并拿到随机端口；
 *   2. 创建「透明、无边框、置顶、全工作区」的宠物窗口（尺寸 = 主屏工作区）：
 *      - 窗口铺满屏幕，宠物在其中的坐标语义与 DSH 网页版完全一致
 *        （window.innerWidth/innerHeight = 工作区尺寸，贴边/漫游逻辑零改动复用）；
 *      - transparent 让窗口背景全透明，只显示宠物动画像素；
 *      - alwaysOnTop('screen-saver') + 所有工作区可见 → 宠物始终悬浮于任何应用之上；
 *      - focusable:false → 不抢占键盘焦点，不打断用户工作；
 *   3. 点击穿透：默认 setIgnoreMouseEvents(true, {forward:true})（点穿到下方应用），
 *      渲染页通过 IPC（pet-interactive）在光标悬停宠物/菜单/弹窗时动态关闭穿透，
 *      光标离开后恢复穿透——宠物即可交互又不挡桌面。
 *
 * 与渲染页的通信：preload.cjs 暴露 window.petDesktop.setInteractive(bool)，
 * 渲染页（electron/renderer/main.ts）用 elementFromPoint 命中测试驱动它。
 *
 * 已知坑：
 *   - 不要用 fullscreen（会独占一个 Space）；铺满工作区 + 所有工作区可见即可；
 *   - macOS 上关闭最后一个窗口不退出应用（托盘/菜单栏后续版本接管）；
 *   - 打包后 __dirname 位于 app.asar/electron，server.cjs 与 index.html 同目录读取。
 */
'use strict';
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const { startServer } = require('./server.cjs');

/** 主窗口引用（穿透开关用） */
let petWindow = null;

/** 创建宠物窗口（透明置顶全工作区） */
function createPetWindow(port) {
  const { workArea } = screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    height: workArea.height,
    transparent: true, // 窗口背景全透明：只显示宠物动画像素
    backgroundColor: '#00000000',
    frame: false, // 无边框
    hasShadow: false, // 无阴影（透明窗口带阴影会有残影）
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false, // 不抢焦点（点击宠物仍可交互，键盘事件不需要）
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, // 安全：渲染页与主进程隔离，只经 preload 暴露最小接口
      nodeIntegration: false,
      backgroundThrottling: false, // 后台不节流：宠物动画保持流畅
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver'); // 置顶层级：屏幕保护层（盖过绝大多数窗口）
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); // 所有 Space 可见
  win.setIgnoreMouseEvents(true, { forward: true }); // 初始：全屏点穿（不挡桌面操作）
  void win.loadURL('http://127.0.0.1:' + port + '/index.html');
  return win;
}

// 应用就绪：起服务器 → 建窗口
app.whenReady().then(async () => {
  const { port } = await startServer();
  petWindow = createPetWindow(port);

  // macOS：Dock 图标点击时不重建窗口（窗口常驻，仅确保可见）
  app.on('activate', () => {
    if (petWindow && !petWindow.isDestroyed()) petWindow.show();
  });
});

// 渲染页 IPC：光标悬停在宠物/菜单/弹窗上 → 关闭穿透（可交互）；离开 → 恢复穿透
ipcMain.on('pet-interactive', (_event, interactive) => {
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.setIgnoreMouseEvents(!interactive, { forward: true });
  }
});

// 所有窗口关闭（不会自然发生；防御处理）：非 macOS 退出应用
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

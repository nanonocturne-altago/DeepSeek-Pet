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
const fs = require('fs');
const { startServer } = require('./server.cjs');

/** 启动诊断日志（写到 /tmp/pet-boot.log，便于排查窗口创建问题；无窗口环境也可读） */
function bootLog(...args) {
  try {
    fs.appendFileSync('/tmp/pet-boot.log', '[' + new Date().toISOString() + '] ' + args.join(' ') + '\n');
  } catch {
    /* 日志失败不阻塞启动 */
  }
}

/** 主窗口引用（穿透开关用） */
let petWindow = null;

/** 创建宠物窗口（透明置顶全工作区） */
function createPetWindow(port) {
  // 显示器选择：远程控制（向日葵等）会注入小尺寸虚拟显示器并可能成为 primary，
  // 导致窗口建到用户看不到的屏幕上。策略：选 workArea 面积最大的显示器（物理屏），
  // 后续版本再做多屏各开一个窗口。
  const displays = screen.getAllDisplays();
  const target = displays.reduce((best, d) =>
    d.workArea.width * d.workArea.height > best.workArea.width * best.workArea.height ? d : best,
  );
  const { workArea } = target;
  bootLog('displays=', displays.length, 'target workArea=', JSON.stringify(workArea));
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
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, // 安全：渲染页与主进程隔离，只经 preload 暴露最小接口
      nodeIntegration: false,
      backgroundThrottling: false, // 后台不节流：宠物动画保持流畅
    },
  });
  bootLog('window created: bounds=', JSON.stringify(win.getBounds()), 'visible=', win.isVisible());
  win.once('ready-to-show', () => bootLog('window ready-to-show'));
  win.webContents.on('did-finish-load', () => bootLog('renderer did-finish-load'));
  win.webContents.on('did-fail-load', (_e, code, desc) => bootLog('renderer did-fail-load', code, desc));
  win.setAlwaysOnTop(true, 'floating'); // 默认（前台显示 OFF）：普通置顶，全屏应用可盖过宠物
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  win.setIgnoreMouseEvents(true, { forward: true }); // 初始：全屏点穿（不挡桌面操作）
  void win.loadURL('http://127.0.0.1:' + port + '/index.html');
  return win;
}

// ---- 「行为」开关（主进程为权威状态，菜单按钮经 preload 桥读写） ----
let dockVisible = true; // 程序坞显示：默认显示 Dock 图标
let foregroundOn = false; // 前台显示：默认不强制（全屏应用可盖过宠物）

/** 按当前 foregroundOn 应用置顶层级 */
function applyForeground() {
  if (!petWindow || petWindow.isDestroyed()) return;
  if (foregroundOn) {
    // 强制最上层：屏幕保护层级 + 全屏 Space 可见 → 盖过包括全屏应用在内的一切
    petWindow.setAlwaysOnTop(true, 'screen-saver');
    petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } else {
    // 普通模式：浮于常规窗口之上，全屏应用（视频/游戏）可盖过宠物
    petWindow.setAlwaysOnTop(true, 'floating');
    petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  }
  // 坑：macOS 在窗口切到 screen-saver 层级并「全屏可见」时会自动隐藏 Dock 图标，
  // 这里在层级变更后重新断言 Dock 状态（延迟补刀一次，抵消系统异步隐藏）
  reassertDock();
}

/** 重新应用 Dock 图标显示状态（抵消 macOS 层级切换引发的 Dock 自动隐藏） */
function reassertDock() {
  if (dockVisible) {
    void app.dock.show();
    setTimeout(() => {
      if (dockVisible) void app.dock.show();
    }, 150);
  } else {
    void app.dock.hide();
  }
}

// 程序坞显示开关：隐藏 Dock 图标后应用不出现于 Cmd+Tab 与 Dock；恢复需经宠物菜单再次打开
ipcMain.on('pet-dock', (_event, show) => {
  dockVisible = !!show;
  bootLog('dock visible=', dockVisible);
  if (dockVisible) void app.dock.show();
  else void app.dock.hide();
});

// 前台显示开关
ipcMain.on('pet-foreground', (_event, on) => {
  foregroundOn = !!on;
  bootLog('foreground=', foregroundOn);
  applyForeground();
});

// 状态查询（菜单打开时同步按钮高亮）
ipcMain.handle('pet-state', () => ({ dock: dockVisible, foreground: foregroundOn }));

// 应用就绪：起服务器 → 建窗口
app.whenReady()
  .then(async () => {
    bootLog('app ready');
    const { port } = await startServer();
    bootLog('server port=', port);
    petWindow = createPetWindow(port);

    // macOS：Dock 图标点击时不重建窗口（窗口常驻，仅确保可见）
    app.on('activate', () => {
      if (petWindow && !petWindow.isDestroyed()) petWindow.show();
    });

    // 显示器拓扑变化（远程连接/断开、插拔外接屏）：重新绑定到面积最大的显示器
    const repositionToLargestDisplay = () => {
      if (!petWindow || petWindow.isDestroyed()) return;
      const ds = screen.getAllDisplays();
      const t = ds.reduce((b, d) =>
        d.workArea.width * d.workArea.height > b.workArea.width * b.workArea.height ? d : b,
      );
      const wa = t.workArea;
      bootLog('reposition: displays=', ds.length, 'workArea=', JSON.stringify(wa));
      petWindow.setBounds({ x: wa.x, y: wa.y, width: wa.width, height: wa.height });
    };
    screen.on('display-added', repositionToLargestDisplay);
    screen.on('display-removed', repositionToLargestDisplay);
    screen.on('display-metrics-changed', repositionToLargestDisplay);
  })
  .catch((err) => {
    bootLog('BOOT_ERROR', String((err && err.stack) || err));
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

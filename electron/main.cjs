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
const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

// ==================== 用户数据目录（独立版专属命名空间） ====================
// 独立版与 DSH 插件彻底解耦：统一使用「DeepSeek.Pet」作为用户数据母目录，
// 避免与 DeepSeek Harness（dsh-*）及原作者的 dsh-pet 产生误解或文件冲突。
// - macOS → ~/Library/Application Support/DeepSeek.Pet
// - Windows 便携版 → 优先 exe 同级 data/（绿色便携、零 C 盘污染）；
//   exe 目录只读时回落 %APPDATA%\DeepSeek.Pet，并弹出「数据存储提示」窗请用户确认
// 注意：必须在 require('./server.cjs') 之前设置——server.cjs 在模块加载期就会解析动画目录。
// 便携 exe 的真实所在目录：自解压便携包运行时 execPath 指向 %TEMP%，
// PORTABLE_EXECUTABLE_DIR 才是用户 exe 所在处（解包目录分发/未打包时不存在，回落 execPath 目录）
const PORTABLE_DIR =
  process.platform === 'win32' && process.env.PORTABLE_EXECUTABLE_DIR
    ? process.env.PORTABLE_EXECUTABLE_DIR
    : path.dirname(process.execPath);

function exeDirWritable() {
  try {
    const dir = PORTABLE_DIR;
    fs.accessSync(dir, fs.constants.W_OK);
    const probe = path.join(dir, '.dspet-write-test');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

let storageFallback = false; // Windows：exe 目录只读 → 已回落 AppData（需要弹提示确认）
if (process.platform === 'win32') {
  if (exeDirWritable()) {
    app.setPath('userData', path.join(PORTABLE_DIR, 'data'));
  } else {
    storageFallback = true;
    app.setPath('userData', path.join(app.getPath('appData'), 'DeepSeek.Pet'));
  }
} else {
  app.setPath('userData', path.join(app.getPath('appData'), 'DeepSeek.Pet'));
}
migrateAnimeDirName(); // 旧名 DSH.Pet.Anime → anime（同样必须在 require 前，否则目录解析到旧名）

const { startServer } = require('./server.cjs');

/** 把历史版本的旧母目录数据迁入新目录（仅迁自有子目录，Electron 自身缓存不迁） */
function migrateLegacyDirs() {
  try {
    const oldBase = path.join(app.getPath('appData'), 'dsh-pet'); // 历史版本 userData 落点
    const newBase = app.getPath('userData');
    if (oldBase === newBase || !fs.existsSync(oldBase)) return;
    for (const [srcSub, dstSub] of [
      ['DSH.Pet.Anime', 'anime'],
      ['sound', 'sound'],
    ]) {
      const src = path.join(oldBase, srcSub);
      const dst = path.join(newBase, dstSub);
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        fs.mkdirSync(newBase, { recursive: true });
        fs.renameSync(src, dst);
        bootLog('migrated ' + srcSub + ' → ' + dst);
      }
    }
  } catch (e) {
    bootLog('migrate error: ' + String(e));
  }
}

/** 动画目录改名迁移：DSH.Pet.Anime → anime（与 sound 命名统一；保留用户 DIY 文件，整体改名） */
function migrateAnimeDirName() {
  try {
    const base = app.getPath('userData');
    const oldDir = path.join(base, 'DSH.Pet.Anime');
    const newDir = path.join(base, 'anime');
    if (fs.existsSync(oldDir) && !fs.existsSync(newDir)) {
      fs.renameSync(oldDir, newDir);
      bootLog('migrated DSH.Pet.Anime → anime');
    }
  } catch (e) {
    bootLog('anime dir rename error: ' + String(e));
  }
}

/**
 * Windows 旧数据迁移：%APPDATA%\DeepSeek.Pet（历史版本落点）→ 当前 userData（exe 同级 data/）。
 * 仅复制顶层文件（设置/账本/API Key），不覆盖；Electron 缓存不迁。
 */
function migrateWinUserData() {
  if (process.platform !== 'win32') return;
  try {
    const oldDir = path.join(app.getPath('appData'), 'DeepSeek.Pet');
    const newDir = app.getPath('userData');
    if (oldDir === newDir || !fs.existsSync(oldDir)) return;
    fs.mkdirSync(newDir, { recursive: true });
    for (const f of fs.readdirSync(oldDir)) {
      const sp = path.join(oldDir, f);
      const dp = path.join(newDir, f);
      if (fs.statSync(sp).isFile() && !fs.existsSync(dp)) fs.copyFileSync(sp, dp);
    }
    bootLog('migrated win user data → ' + newDir);
  } catch (e) {
    bootLog('win data migrate error: ' + String(e));
  }
}

/**
 * 数据存储提示窗（Windows：exe 目录只读 → 已回落 AppData）。
 * 风格参考「特别鸣谢」弹窗；用户点击「确认」= 授权写入 AppData 并关闭本窗。
 */
function showFallbackDialog() {
  return new Promise((resolve) => {
    const dialogWin = new BrowserWindow({
      width: 452,
      height: 300,
      frame: false,
      transparent: true,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      webPreferences: {
        preload: path.join(__dirname, 'dialog-preload.cjs'),
        contextIsolation: true,
      },
    });
    ipcMain.once('fallback-confirm', () => {
      bootLog('storage fallback confirmed by user');
      if (!dialogWin.isDestroyed()) dialogWin.close();
      resolve();
    });
    dialogWin.on('closed', resolve); // 兜底：被关闭也继续启动
    void dialogWin.loadFile(path.join(__dirname, 'fallback-dialog.html'));
  });
}

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
let dockVisible = true; // 托盘显示（Windows）/ 程序坞显示（macOS）：默认显示系统图标
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

/** 重新应用 Dock 图标显示状态（抵消 macOS 层级切换引发的 Dock 自动隐藏；仅 macOS） */
function reassertDock() {
  if (process.platform !== 'darwin') return;
  if (dockVisible) {
    void app.dock.show();
    setTimeout(() => {
      if (dockVisible) void app.dock.show();
    }, 150);
  } else {
    void app.dock.hide();
  }
}

/** 显示/隐藏托盘图标（Windows）：隐藏=销毁托盘，显示=重建（Electron 托盘无 hide API） */
function setTrayVisible(show) {
  if (process.platform !== 'win32') return;
  if (show) {
    if (!tray || tray.isDestroyed()) createTray();
  } else if (tray && !tray.isDestroyed()) {
    tray.destroy();
    tray = null;
  }
}

// 「托盘显示 / 程序坞显示」开关：Windows 切换托盘图标，macOS 切换 Dock 图标
ipcMain.on('pet-dock', (_event, show) => {
  dockVisible = !!show;
  bootLog('dock/tray visible=', dockVisible);
  if (process.platform === 'win32') {
    setTrayVisible(dockVisible);
    return;
  }
  if (dockVisible) void app.dock.show();
  else void app.dock.hide();
});

// 前台显示开关
ipcMain.on('pet-foreground', (_event, on) => {
  foregroundOn = !!on;
  bootLog('foreground=', foregroundOn);
  applyForeground();
});

// 键盘焦点开关：默认 focusable:false（宠物不打断用户工作）；
// API Key 弹窗等需要键盘输入的界面打开时临时开启并聚焦，关闭后恢复不抢焦点
ipcMain.on('pet-focusable', (_event, on) => {
  if (!petWindow || petWindow.isDestroyed()) return;
  petWindow.setFocusable(!!on);
  if (on) petWindow.focus();
  bootLog('focusable=', !!on);
});

// 状态查询（菜单打开时同步按钮高亮）
ipcMain.handle('pet-state', () => ({ dock: dockVisible, foreground: foregroundOn }));

// ==================== Windows 系统托盘 ====================

let tray = null; // 托盘图标（仅 Windows）

/** 创建系统托盘：右键图标弹出自定义菜单弹窗（更多功能后续追加按钮） */
function createTray() {
  if (process.platform !== 'win32') return; // macOS 走程序坞方案，不建托盘
  const iconPath = path.join(__dirname, '..', 'assets', 'icon.png');
  let icon = null;
  try {
    // 托盘图标 16×16（Windows 系统托盘尺寸），由应用图标缩放得到
    icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  } catch {
    bootLog('tray icon load failed, use default');
  }
  tray = new Tray(icon || nativeImage.createEmpty());
  tray.setToolTip('DeepSeek娘相随');
  // 右键托盘图标弹出原生上下文菜单（Windows 上 setContextMenu 后右键自动弹出）
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'DeepSeek娘相随', enabled: false },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          bootLog('quit via tray context menu');
          app.quit();
        },
      },
    ]),
  );
}



// 应用就绪：起服务器 → 建窗口
app.whenReady()
  .then(async () => {
    bootLog('app ready');
    if (process.platform === 'win32' && storageFallback) await showFallbackDialog(); // 只读目录回落 AppData：先弹提示确认
    migrateLegacyDirs(); // 旧母目录（dsh-pet）→ DeepSeek.Pet（必须在服务播种前，否则 DIY 文件不会被迁移）
    migrateWinUserData(); // Windows 旧 %APPDATA% 数据 → exe 同级 data/
    const { port } = await startServer();
    bootLog('server port=', port);
    petWindow = createPetWindow(port);
    createTray(); // Windows：系统托盘（macOS 下为空操作）

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

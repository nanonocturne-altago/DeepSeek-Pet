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
const { exec, execSync } = require('child_process');
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

const { startServer, setDisplayInfoProvider } = require('./server.cjs');

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
/** 虚拟桌面联合区域：所有物理显示器的包围盒（宠物可在多屏间自由拖动/漫游） */
function virtualDesktopBounds() {
  const ds = screen.getAllDisplays();
  if (ds.length === 0) return { x: 0, y: 0, width: 1280, height: 800 };
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const d of ds) {
    const b = d.bounds; // 用完整 bounds（含任务栏/菜单栏区域）：透明覆盖层需要覆盖整块屏幕
    x1 = Math.min(x1, b.x);
    y1 = Math.min(y1, b.y);
    x2 = Math.max(x2, b.x + b.width);
    y2 = Math.max(y2, b.y + b.height);
  }
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/** 主显示器在窗口坐标空间中的矩形（供渲染页把默认角落定位锚定在主屏） */
function computeDisplayInfo() {
  try {
    const vb = virtualDesktopBounds();
    const p = screen.getPrimaryDisplay().bounds;
    return { primary: { x: p.x - vb.x, y: p.y - vb.y, width: p.width, height: p.height } };
  } catch {
    return null;
  }
}
setDisplayInfoProvider(computeDisplayInfo);

function createPetWindow(port) {
  // 多显示器支持：窗口覆盖所有显示器的联合区域（虚拟桌面），
  // 宠物在该窗口内移动即等于在任意屏幕间拖动/漫游；
  // 显示器插拔/远程会话变化时在 display 事件里重新贴合联合区域并让客户端重新钳制位置。
  const vb = virtualDesktopBounds();
  bootLog('virtual desktop bounds=', JSON.stringify(vb));
  const win = new BrowserWindow({
    x: vb.x,
    y: vb.y,
    width: vb.width,
    height: vb.height,
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
    // 强制最上层：屏幕保护层级 → 盖过包括全屏应用在内的一切
    petWindow.setAlwaysOnTop(true, 'screen-saver');
    petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } else {
    // 普通模式：浮于常规窗口之上，全屏应用（视频/游戏）可盖过宠物
    petWindow.setAlwaysOnTop(true, 'floating');
    petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  }
}

// ==================== macOS Dock 图标显示（LSUIElement 持久方案） ====================
//
// 背景（血泪教训，macOS 26 + Electron 31/40/44 实测）：
//   运行时切换（app.dock.hide / setActivationPolicy / killall Dock）在「全工作区可见」
//   窗口的应用上全部不可靠：图标留存、米粒白点残留、恢复失效、Dock 闪动。
// 定稿方案（Macs Fan Control 同款）：LSUIElement（Info.plist 标志）——应用启动时系统
//   就不注册 Dock 图标，零闪动零残留；切换 = 改 Info.plist + 重签 + 自动重启生效。
//   设置持久化在用户数据目录 widget-settings.json 的 dockVisible 字段。

/** dockVisible 设置文件路径（与 server.cjs 的 USER_DATA 同源，支持 DSH_PET_USER_DATA 隔离） */
function dockSettingsPath() {
  return path.join(process.env.DSH_PET_USER_DATA || app.getPath('userData'), 'widget-settings.json');
}

/** 读取 dockVisible 持久设置（widget-settings.json；缺失默认 true=显示） */
function readDockSetting() {
  try {
    const j = JSON.parse(fs.readFileSync(dockSettingsPath(), 'utf8'));
    return j.dockVisible !== false;
  } catch {
    return true;
  }
}

/** 写入 dockVisible 持久设置（保留其它字段） */
function writeDockSetting(v) {
  const p = dockSettingsPath();
  let j = {};
  try {
    j = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    /* 首次无文件 */
  }
  j.dockVisible = !!v;
  fs.writeFileSync(p, JSON.stringify(j, null, 2));
}

/** 应用 bundle 根路径（exe 在 Contents/MacOS/ 下，上溯两层） */
function appBundlePath() {
  return path.resolve(path.dirname(app.getPath('exe')), '..', '..');
}

/** 读取 Info.plist 是否已有 LSUIElement 标志（true = 启动即无 Dock 图标） */
function plistHasLSUIElement() {
  try {
    const out = execSync('/usr/libexec/PlistBuddy -c "Print :LSUIElement" ' + shellQuote(appBundlePath() + '/Contents/Info.plist')).toString();
    return /true/i.test(out);
  } catch {
    return false;
  }
}

/** 修改 Info.plist 的 LSUIElement 标志（hidden=true 时应用不再出现在 Dock） */
function setPlistLSUIElement(hidden) {
  const plist = appBundlePath() + '/Contents/Info.plist';
  // 键不存在时 Delete 会报错——先容错删（幂等）
  try {
    execSync('/usr/libexec/PlistBuddy -c "Delete :LSUIElement" ' + shellQuote(plist));
  } catch {
    /* 本来就没有 */
  }
  if (hidden) {
    execSync('/usr/libexec/PlistBuddy -c "Add :LSUIElement bool true" ' + shellQuote(plist));
  }
}

/** 重签应用（改 Info.plist 后必须重签，否则下次启动被 Gatekeeper 判「已损坏」） */
function resignApp() {
  execSync('codesign --force --deep -s "Deepseek Local" ' + shellQuote(appBundlePath()));
}

/** 强制 LaunchServices 重新注册应用（改 Info.plist 后注册缓存不会自动更新，
 *  不重注册 LSUIElement 会被忽略——Dock 仍按旧注册信息显示图标） */
function reregisterApp() {
  execSync(
    '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f ' +
      shellQuote(appBundlePath()),
  );
}

/** 切换 Dock 图标显示（macOS）：写设置 → 改 plist → 重签 → 重注册。下次启动生效，不重启当前会话 */
function applyDockSetting(next) {
  dockVisible = next; // 即时更新按钮状态（持久设置值 = 下次启动生效的样子）
  writeDockSetting(next);
  setPlistLSUIElement(!next); // 隐藏 = LSUIElement true
  resignApp();
  reregisterApp();
  bootLog('dock setting=', next, 'LSUIElement=', !next, '(effective on next launch)');
}

/** shell 引号转义（用于 exec 拼接路径） */
function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/** 挂载 Dock 右键菜单（「归中」；幂等，重复调用整体替换） */
function setupDockMenu() {
  if (process.platform !== 'darwin') return;
  app.dock.setMenu(
    Menu.buildFromTemplate([
      {
        label: '归中',
        click: () => {
          bootLog('center via dock context menu');
          centerPetToCursorScreen();
        },
      },
    ]),
  );
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

/**
 * 归中：把宠物移动到「鼠标所在屏幕」的正中央（拿不到光标位置时回落主显示器）。
 * 场景：多屏/远程会话后宠物跑到看不见的位置——托盘或程序坞菜单点「归中」一键找回。
 * 实现：目标点换算成窗口坐标（虚拟桌面联合区域左上角为原点）经 IPC 推给渲染页，
 *       渲染页再转成视口比例坐标写回 customPos（与拖拽落点同口径，继承贴边钳制）。
 */
function centerPetToCursorScreen() {
  if (!petWindow || petWindow.isDestroyed()) return;
  try {
    let d = null;
    try {
      d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    } catch {
      /* 光标信息不可用（罕见）→ 回落主显示器 */
    }
    if (!d) d = screen.getPrimaryDisplay();
    const b = d.bounds;
    const vb = virtualDesktopBounds();
    petWindow.webContents.send('pet-center', {
      x: b.x + b.width / 2 - vb.x,
      y: b.y + b.height / 2 - vb.y,
    });
  } catch (err) {
    bootLog('center pet failed', String((err && err.stack) || err));
  }
}

// 「托盘显示 / 程序坞显示」开关：Windows 切换托盘图标，macOS 走 LSUIElement 持久方案
ipcMain.on('pet-dock', (_event, show) => {
  const next = !!show;
  bootLog('dock/tray visible=', next);
  if (process.platform === 'win32') {
    dockVisible = next;
    setTrayVisible(next);
    return;
  }
  // macOS：写设置 → 改 Info.plist(LSUIElement) → 重签 → 自动重启生效（无闪动）
  try {
    applyDockSetting(next);
  } catch (err) {
    bootLog('applyDockSetting failed', String((err && err.stack) || err));
  }
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
        label: '归中',
        click: () => {
          bootLog('center via tray context menu');
          centerPetToCursorScreen();
        },
      },
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

    // macOS：Dock 图标显示 = LSUIElement 持久方案。
    // 启动时同步「用户设置」与「Info.plist」（如用户重装过应用）：只改 plist + 重签，
    // 下次启动生效（当前会话图标状态由本次启动时的 plist 决定，无法运行时改变）
    if (process.platform === 'darwin') {
      dockVisible = readDockSetting();
      const plistHidden = plistHasLSUIElement();
      if (plistHidden !== !dockVisible) {
        try {
          setPlistLSUIElement(!dockVisible);
          resignApp();
          reregisterApp();
          bootLog('dock plist synced to setting (effective next launch)');
        } catch (err) {
          bootLog('dock sync failed, continue anyway', String((err && err.stack) || err));
        }
      }
      if (!plistHidden) setupDockMenu(); // 本会话图标可见才挂 Dock 右键菜单（「归中」）
    }

    // macOS：Dock 图标点击时不重建窗口（窗口常驻，仅确保可见）
    app.on('activate', () => {
      if (petWindow && !petWindow.isDestroyed()) petWindow.show();
    });

    // 显示器拓扑变化（远程连接/断开、插拔外接屏）：重新贴合虚拟桌面联合区域
    const refitVirtualDesktop = () => {
      if (!petWindow || petWindow.isDestroyed()) return;
      const vb = virtualDesktopBounds();
      bootLog('refit virtual desktop: displays=', screen.getAllDisplays().length, 'bounds=', JSON.stringify(vb));
      petWindow.setBounds({ x: vb.x, y: vb.y, width: vb.width, height: vb.height });
      // setBounds 触发渲染页 resize → 宠物位置自动重新钳制回新边界内
    };
    screen.on('display-added', refitVirtualDesktop);
    screen.on('display-removed', refitVirtualDesktop);
    screen.on('display-metrics-changed', refitVirtualDesktop);
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

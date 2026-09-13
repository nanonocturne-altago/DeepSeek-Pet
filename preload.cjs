/**
 * 预加载脚本：渲染页与主进程之间唯一的安全桥。
 *
 * 暴露 window.petDesktop（contextIsolation 开启，渲染页只能经它触达主进程）：
 *   - setInteractive(bool) 光标在宠物/菜单/弹窗上（true=关闭点击穿透，宠物可交互）
 *   - setDockVisible(bool)  切换程序坞（Dock）中应用图标的显示/隐藏（仅 macOS）
 *   - setForeground(bool)   切换「前台显示」（强制盖过全屏应用）
 *   - getState()            查询 dock/foreground 当前状态（菜单打开时同步按钮高亮）
 *   - onCenter(cb)          监听「归中」指令（托盘/程序坞菜单触发），回调收到目标点
 *                           （窗口坐标 px），返回取消订阅函数
 *   - quitApp()             退出整个应用（托盘菜单「关闭程序」按钮使用）
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petDesktop', {
  setInteractive: (interactive) => ipcRenderer.send('pet-interactive', interactive),
  setDockVisible: (show) => ipcRenderer.send('pet-dock', show),
  setForeground: (on) => ipcRenderer.send('pet-foreground', on),
  setFocusable: (on) => ipcRenderer.send('pet-focusable', on),
  getState: () => ipcRenderer.invoke('pet-state'),
  onCenter: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('pet-center', listener);
    // 返回取消订阅：渲染页 effect 卸载时调用，防止重复注册/泄漏
    return () => ipcRenderer.removeListener('pet-center', listener);
  },
  platform: process.platform,
});

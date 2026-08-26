/**
 * 预加载脚本：渲染页与主进程之间唯一的安全桥。
 *
 * 暴露 window.petDesktop（contextIsolation 开启，渲染页只能经它触达主进程）：
 *   - setInteractive(bool) 光标在宠物/菜单/弹窗上（true=关闭点击穿透，宠物可交互）
 *   - setDockVisible(bool)  切换程序坞（Dock）中应用图标的显示/隐藏
 *   - setForeground(bool)   切换「前台显示」（强制置顶于所有应用之上，含全屏）
 *   - getState()            读取 {dock, foreground} 当前状态（菜单打开时同步按钮高亮）
 *
 * 通信方向：setXxx → ipcRenderer.send（单向，主进程异步执行）；
 *          getState → ipcRenderer.invoke（双向，等待主进程返回）。
 * 已知坑：contextIsolation 下 window 对象不是同一份——必须用 contextBridge 暴露，
 *         不能直接在 preload 里给 window 挂属性。
 */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petDesktop', {
  setInteractive: (interactive) => ipcRenderer.send('pet-interactive', interactive),
  setDockVisible: (show) => ipcRenderer.send('pet-dock', show),
  setForeground: (on) => ipcRenderer.send('pet-foreground', on),
  getState: () => ipcRenderer.invoke('pet-state'),
});

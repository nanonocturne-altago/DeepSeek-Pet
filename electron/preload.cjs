/**
 * 预加载脚本：渲染页与主进程之间唯一的安全桥。
 *
 * 只暴露一个最小接口 window.petDesktop.setInteractive(bool)：
 *   true  = 光标在宠物/菜单/弹窗上（主进程关闭点击穿透，宠物可交互）
 *   false = 光标在空白处（主进程恢复点击穿透，点击落到下方应用）
 *
 * contextIsolation 开启：渲染页无法直接触碰 Node/IPC，只能经此桥通信。
 */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petDesktop', {
  /** @param interactive 是否允许鼠标交互（true=关闭穿透） */
  setInteractive: (interactive) => ipcRenderer.send('pet-interactive', !!interactive),
});

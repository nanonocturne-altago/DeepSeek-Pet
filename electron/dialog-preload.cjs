/**
 * 数据存储提示弹窗的预加载桥：只暴露 confirmFallback()（确认写入 AppData）
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petDialog', {
  confirmFallback: () => ipcRenderer.send('fallback-confirm'),
});

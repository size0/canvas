/**
 * 预加载脚本：向渲染进程暴露窗口控制 API（无边框窗口的最小化/最大化/关闭）
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopWindow', {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
    onMaximizeChange: (cb) => {
        const handler = (_e, val) => cb(val);
        ipcRenderer.on('window:maximize-changed', handler);
        return () => ipcRenderer.removeListener('window:maximize-changed', handler);
    },
});

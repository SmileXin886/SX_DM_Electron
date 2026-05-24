/**
 * preload_overlay.js - 悬浮窗安全预加载脚本
 * 为透明子窗口的 renderer 进程暴露安全的 API
 * 遵循 contextBridge 规范，不暴露 Node.js 运行时
 *
 * 注意：拖拽已迁移至 CSS 原生实现（-webkit-app-region: drag）
 * 不再需要 window.overlayAPI.moveBy
 */
const { contextBridge, ipcRenderer } = require('electron');

/**
 * 监听来自主进程的积分更新
 * 通道名: tracker:update-points
 */
const VALID_SEND_CHANNELS = ['tracker:toggle-global', 'tracker:force-reconcile'];
const VALID_RECV_CHANNELS = ['tracker:update-points', 'tracker:update-profile'];

contextBridge.exposeInMainWorld('electron', {
    on: (channel, callback) => {
        if (VALID_RECV_CHANNELS.includes(channel)) {
            ipcRenderer.on(channel, (event, ...args) => callback(...args));
        }
    },
    off: (channel, callback) => {
        if (VALID_RECV_CHANNELS.includes(channel)) {
            ipcRenderer.removeListener(channel, callback);
        }
    },
    send: (channel, data) => {
        if (VALID_SEND_CHANNELS.includes(channel)) {
            ipcRenderer.send(channel, data);
        }
    },
    invoke: (channel, ...args) => {
        if (channel === 'tracker:request-profile') {
            return ipcRenderer.invoke(channel, ...args);
        }
    },
});

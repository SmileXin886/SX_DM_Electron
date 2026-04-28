/**
 * preload.js - Electron 安全预加载层
 * ===================================
 * 职责：
 * - 通过 contextBridge.exposeInMainWorld 向渲染进程暴露安全的 API
 * - 渲染进程（前端 JS）只能访问这里暴露的接口
 * - 绝对禁止将 Node.js 或 Electron API 直接暴露给 renderer
 */

const { contextBridge, ipcRenderer } = require('electron');

/**
 * 定义 electronAPI 接口
 * 前端通过 window.electronAPI.xxx() 调用
 */
contextBridge.exposeInMainWorld('electronAPI', {
    // ==================== 系统级 API ====================

    /**
     * 打开文件选择对话框
     * @param {Object} options - dialog.showOpenDialog 选项
     * @returns {Promise<{canceled: boolean, filePaths: string[]}>}
     */
    openFileDialog: (options) => ipcRenderer.invoke('dialog:openFile', options),

    /**
     * 打开文件夹选择对话框
     * @param {Object} options - dialog.showOpenDialog 选项
     * @returns {Promise<{canceled: boolean, filePaths: string[]}>}
     */
    openDirectory: (options) => ipcRenderer.invoke('dialog:openDirectory', options),

    /**
     * 获取 Python 服务 URL
     * @returns {Promise<string>}
     */
    getServerUrl: () => ipcRenderer.invoke('app:getServerUrl'),

    /**
     * 获取应用信息
     * @returns {Promise<{version: string, platform: string, arch: string, appPath: string, webUiPath: string, pythonPath: string}>}
     */
    getAppInfo: () => ipcRenderer.invoke('app:getInfo'),
    /**
     * 使用系统默认应用预览媒体文件
     * @param {string} filePath - 文件绝对路径
     */
    previewMedia: (filePath) => ipcRenderer.invoke('app:previewMedia', filePath),
});

/**
 * 通知渲染进程：Electron 已就绪
 * 这会替代之前 Qt WebChannel 的 bridge-ready 事件
 */
window.dispatchEvent(new CustomEvent('electron-ready'));

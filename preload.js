/**
 * preload.js - Electron 安全预加载层
 * ===================================
 * 职责：
 * - 通过 contextBridge.exposeInMainWorld 向渲染进程暴露安全的 API
 * - 渲染进程（前端 JS）只能访问这里暴露的接口
 * - 绝对禁止将 Node.js 或 Electron API 直接暴露给 renderer
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

/**
 * 定义 electronAPI 接口
 * 前端通过 window.electronAPI.xxx() 调用
 */
contextBridge.exposeInMainWorld('electronAPI', {
    // ==================== 系统级 API ====================

    /**
     * 从拖拽的 File 对象获取真实的文件系统路径
     * Electron 专有 API，绕过沙箱限制
     * @param {File} file - 拖拽事件中的 File 对象
     * @returns {Promise<string>} 真实绝对路径
     */
    getPathForFile: (file) => webUtils.getPathForFile(file),

    /**
     * 打开文件选择对话框
     * @returns {Promise<{canceled: boolean, filePaths: string[]}>}
     */
    openFileDialog: (options) => ipcRenderer.invoke('dialog:openFile', options),

    /**
     * 打开文件夹选择对话框
     * @returns {Promise<{canceled: boolean, filePaths: string[]}>}
     */
    openDirectory: (options) => ipcRenderer.invoke('dialog:openDirectory', options),

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

    // ==================== 预设管理 API（走 preset_ipc.py）====================

    /**
     * 获取所有预设
     */
    getPresets: () => ipcRenderer.invoke('preset:list'),

    /**
     * 创建预设
     * @param {Object} presetData - { name, settings, textContent, imageURIs, file_path }
     */
    createPreset: (presetData) => ipcRenderer.invoke('preset:create', presetData),

    /**
     * 删除预设
     * @param {string} presetId
     */
    deletePreset: (presetId) => ipcRenderer.invoke('preset:delete', presetId),
});

/**
 * 通知渲染进程：Electron 已就绪
 */
window.dispatchEvent(new CustomEvent('electron-ready'));

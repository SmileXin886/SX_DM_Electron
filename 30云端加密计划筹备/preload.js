/**
 * preload.js - Electron 安全预加载层
 * ===================================
 * 职责：
 * - 通过 contextBridge.exposeInMainWorld 向渲染进程暴露安全的 API
 * - 渲染进程（前端 JS）只能访问这里暴露的接口
 * - 绝对禁止将 Node.js 或 Electron API 直接暴露给 renderer
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

// ====== 终极防御：阻止 Chromium 默认的拖拽打开文件行为 ======
// 通过 preload 强行注入到即梦网页中，免疫手抖拖拽引发的页面跳转
document.addEventListener('dragover', (e) => {
    e.preventDefault(); 
});

document.addEventListener('drop', (e) => {
    const target = e.target;
    const isInput = target.tagName && target.tagName.toLowerCase() === 'input';
    if (!isInput) {
        e.preventDefault(); 
    }
});
// ==============================================================

// ====== 风控对抗与伪装层 (注入阶段) ======

// 1. 抹除自动化特征 (同步执行)
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
window.navigator.chrome = { runtime: {} };

// 2. 【终极安全补丁】通过安全 IPC 主动拉取风控变量，彻底杜绝命令行泄露
ipcRenderer.invoke('get-secure-page-vars').then(pageVars => {
    if (pageVars && Object.keys(pageVars).length > 0) {
        try {
            // 利用 DOM 挂载 script 标签，突破 contextIsolation 隔离，打入真实的 window 对象
            const script = document.createElement('script');
            script.textContent = `Object.assign(window, ${JSON.stringify(pageVars)});`;
            document.documentElement.appendChild(script);
            script.remove(); // 阅后即焚，不在 DOM 留痕
        } catch (e) {
            console.error('全局变量注入失败');
        }
    }
}).catch(() => {});
// ==========================================

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

    // ==================== 即梦账号管理 API ====================

    /**
     * 获取即梦账号列表
     */
    listJimengAccounts: () => ipcRenderer.invoke('jimeng:listAccounts'),

    /**
     * 导入 .sxc 账号（返回账号信息，不含敏感数据）
     * @param {number[]} fileBuffer - ArrayBuffer 视图
     * @param {string} fileName - 文件名
     */
    importJimengAccount: (fileBuffer, fileName) => ipcRenderer.invoke('jimeng:importAccount', fileBuffer, fileName),

    /**
     * 启动账号的安全浏览器窗口
     * @param {string} accountId
     */
    launchJimengAccount: (accountId) => ipcRenderer.invoke('jimeng:launchAccount', accountId),

    /**
     * 删除即梦账号
     * @param {string} accountId
     */
    deleteJimengAccount: (accountId) => ipcRenderer.invoke('jimeng:deleteAccount', accountId),

    /**
     * 重新排序即梦账号
     * @param {string[]} orderedIds - 账号 ID 数组（新顺序）
     */
    reorderJimengAccounts: (orderedIds) => ipcRenderer.invoke('jimeng:reorderAccounts', orderedIds),

    /**
     * 查询当前正在运行的即梦账号窗口列表
     * @returns {Promise<{success: boolean, activeIds: string[]}>}
     */
    getActiveWindows: () => ipcRenderer.invoke('jimeng:getActiveWindows'),

    /**
     * 监听主进程推送事件
     * @param {string} channel - 事件名
     * @param {Function} callback - 回调函数
     */
    on: (channel, callback) => {
        const validChannels = ['jimeng:refreshList', 'jimeng:windowClosed'];
        if (validChannels.includes(channel)) {
            ipcRenderer.on(channel, (event, ...args) => callback(...args));
        }
    },
});

/**
 * 通知渲染进程：Electron 已就绪
 */
window.dispatchEvent(new CustomEvent('electron-ready'));

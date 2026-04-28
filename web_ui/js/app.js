/**
 * 主入口初始化 (app.js)
 * =====================
 * 负责页面加载完成后的初始化流程
 * 协调 store、api 和各模块的启动顺序
 *
 * - API.init() 轮询等待 electronAPI 就绪后，触发 bridge:ready
 */

import { TabService } from './tabs/tab_service.js';
import './tabs/tab_presets.js';
import './tabs/tab_tasks.js';

console.log('[app.js] 主入口加载中...');

/**
 * 页面加载完成后初始化
 */
function init() {
    console.log('[app.js] 开始初始化...');

    // 1. 初始化 API 层（连接 electronAPI 和 WebSocket）
    window.API.init();

    // 2. 监听 Bridge 就绪事件（由 api.js 在 electronAPI 就绪后触发）
    window.EventBus.on('bridge:ready', onBridgeReady);
    window.EventBus.on('bridge:error', onBridgeError);

    // 3. 监听服务在线/离线事件
    window.EventBus.on('server:online', onServerOnline);
    window.EventBus.on('server:offline', onServerOffline);

    // 4. 初始化页面切换逻辑
    initNavigation();

    // 5. 初始化编辑区标签同步模块
    if (window.EditorTagSync) {
        window.EditorTagSync.init && window.EditorTagSync.init();
    }

    console.log('[app.js] 初始化完成，等待 Electron 连接...');
}

/**
 * Bridge 就绪后的处理
 */
function onBridgeReady() {
    console.log('[app.js] Bridge 已就绪，开始初始化模块...');

    // 初始化服务控制台模块
    TabService.init();

    // 初始化预设管理模块
    window.initPresets();

    // 初始化任务控制台模块
    window.TabTasks && window.TabTasks.init();

    // 初始化日志
    addLog('Dreamina Toolkit 已就绪', 'success');

    console.log('[app.js] 所有模块初始化完成');
}

/**
 * Bridge 连接错误
 */
function onBridgeError(error) {
    console.error('[app.js] Bridge 连接错误:', error);
    addLog('electronAPI 连接失败，请确认在 Electron 环境中运行', 'error');
}

/**
 * 服务上线
 */
function onServerOnline(health) {
    console.log('[app.js] 服务已上线:', health);
    window.AppState.setServerRunning(true);
    window.AppState.setWsUrl('ws://127.0.0.1:8765/ws');
    addLog('Python 服务已就绪', 'success');
}

/**
 * 服务离线
 */
function onServerOffline() {
    console.log('[app.js] 服务已离线');
    window.AppState.setServerRunning(false);
    addLog('Python 服务不可用', 'warning');
}

/**
 * 初始化页面导航
 */
function initNavigation() {
    document.querySelectorAll('.nav-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');

            const page = tab.dataset.page;
            document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
            document.getElementById('page-' + page)?.classList.add('active');

            if (page === 'presets') {
                window.API && window.API.getPresets && window.API.getPresets();
            }
        });
    });

    console.log('[app.js] 导航初始化完成');
}

/**
 * 添加日志（供外部调用）
 */
function addLog(message, type = 'info') {
    const panel = document.getElementById('logPanel');
    if (!panel) return;

    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const div = document.createElement('div');
    div.className = 'log-line log-' + type;
    div.textContent = time + '  ' + message;
    panel.appendChild(div);
    panel.scrollTop = panel.scrollHeight;
}

/**
 * 显示 Toast 提示
 */
function showToast(message) {
    const toast = document.getElementById('toast');
    if (!toast) return;

    toast.textContent = message;
    toast.className = 'toast show';

    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}

// 订阅 Toast 事件（从 EventBus）
window.EventBus && window.EventBus.on('toast', (data) => {
    showToast(data.message || data.text || '');
});

// 导出公共函数到 window（供 HTML 内联调用）
window.addLog = addLog;
window.showToast = showToast;

// DOMContentLoaded 后执行初始化
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

console.log('[app.js] 主入口脚本已加载');

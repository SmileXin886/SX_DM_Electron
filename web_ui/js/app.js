/**
 * 主入口初始化 (app.js)
 */
import { TabService } from './tabs/tab_service.js';
import './tabs/tab_presets.js';
import { TabTasks } from './tabs/tab_tasks.js';

console.log('[app.js] 主入口加载中...');

// 【修复 1：强制暴露给全局，供 HTML 的 onclick 调用】
window.TabService = TabService;
window.TabTasks = TabTasks;

function init() {
    console.log('[app.js] 开始初始化...');

    // 【修复 2：时序问题！必须先绑定事件监听，再调用 API.init()】
    // 否则 api.js 瞬间触发 bridge:ready 时，这里根本还没开始监听
    window.EventBus.on('bridge:ready', onBridgeReady);
    window.EventBus.on('bridge:error', onBridgeError);
    window.EventBus.on('server:online', onServerOnline);
    window.EventBus.on('server:offline', onServerOffline);

    // 绑定完监听后，再去初始化 API 层
    window.API.init();

    initNavigation();

    if (window.EditorTagSync) {
        window.EditorTagSync.init && window.EditorTagSync.init();
    }

    console.log('[app.js] 初始化完成，等待 Electron 连接...');
}

function onBridgeReady() {
    console.log('[app.js] Bridge 已就绪，开始初始化模块...');
    TabService.init();
    window.initPresets && window.initPresets();
    TabTasks.init();
    addLog('Dreamina Toolkit 已就绪', 'success');
    console.log('[app.js] 所有模块初始化完成');
}

function onBridgeError(error) {
    console.error('[app.js] Bridge 连接错误:', error);
    addLog('electronAPI 连接失败，请确认在 Electron 环境中运行', 'error');
}

function onServerOnline(health) {
    console.log('[app.js] 服务已上线:', health);
    window.AppState.setServerRunning(true);
    window.AppState.setWsUrl('ws://127.0.0.1:8765/ws');
    addLog('连接服务已就绪，网关已开启', 'success');
}

function onServerOffline() {
    console.log('[app.js] 服务已离线');
    window.AppState.setServerRunning(false);
    addLog('连接服务未启动...', 'warning');
}

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
            if (page === 'register') {
                window.RegisterApp && window.RegisterApp.init && window.RegisterApp.init();
            }
        });
    });

    console.log('[app.js] 导航初始化完成');
}

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

window.EventBus && window.EventBus.on('toast', (data) => {
    showToast(data.message || data.text || '');
});

window.addLog = addLog;
window.showToast = showToast;

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

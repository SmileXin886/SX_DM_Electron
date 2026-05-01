/**
 * TabManager - 按需加载 Tab 模块
 * 负责动态加载 HTML 模板和 CSS 资源，实现代码分割和样式隔离
 */
const TabManager = {
    // 已加载的 Tab 缓存
    _loadedTabs: new Map(),

    /**
     * 加载 Tab 模块
     * @param {string} tabId - 目标容器 ID（不含 # 前缀）
     * @param {string} htmlUrl - HTML 模板路径
     * @param {string[]} cssUrls - CSS 文件路径数组
     * @param {Function} callback - 加载完成后回调
     * @param {string[]} jsUrls - JS 文件路径数组（可选）
     */
    async load(tabId, htmlUrl, cssUrls, callback, jsUrls = []) {
        const container = document.getElementById(tabId);
        if (!container) {
            console.error(`[TabManager] 容器 #${tabId} 不存在`);
            return;
        }

        // 已加载则直接执行 callback
        if (this._loadedTabs.has(tabId)) {
            console.log(`[TabManager] Tab ${tabId} 已加载，跳过`);
            if (callback) callback();
            return;
        }

        console.log(`[TabManager] 开始加载 Tab ${tabId}...`);

        try {
            // 1. 动态加载 JS 模块（按顺序）
            for (const jsUrl of jsUrls) {
                await this._injectJS(jsUrl);
            }

            // 2. 加载 HTML 模板
            const htmlRes = await fetch(htmlUrl);
            if (!htmlRes.ok) throw new Error(`HTML 加载失败: ${htmlRes.status}`);
            const html = await htmlRes.text();
            container.innerHTML = html;

            // 3. 动态注入 CSS（按顺序）
            for (const cssUrl of cssUrls) {
                await this._injectCSS(cssUrl);
            }

            // 4. 标记为已加载
            this._loadedTabs.set(tabId, { htmlUrl, cssUrls, jsUrls });

            console.log(`[TabManager] Tab ${tabId} 加载完成`);
            if (callback) callback();

        } catch (err) {
            console.error(`[TabManager] 加载失败:`, err);
            container.innerHTML = `<div style="padding:20px;color:#f85149;">加载失败: ${err.message}</div>`;
        }
    },

    /**
     * 动态注入 CSS 文件到 <head>
     * @param {string} cssUrl - CSS 文件路径
     */
    _injectCSS(cssUrl) {
        return new Promise((resolve, reject) => {
            // 检查是否已存在相同链接
            const existing = document.querySelector(`link[href="${cssUrl}"]`);
            if (existing) {
                console.log(`[TabManager] CSS 已存在: ${cssUrl}`);
                resolve();
                return;
            }

            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = cssUrl;
            link.onload = () => {
                console.log(`[TabManager] CSS 注入成功: ${cssUrl}`);
                resolve();
            };
            link.onerror = (e) => {
                console.error(`[TabManager] CSS 加载失败: ${cssUrl}`, e);
                reject(new Error(`CSS 加载失败: ${cssUrl}`));
            };
            document.head.appendChild(link);
        });
    },

    /**
     * 动态注入 JS 文件（同步脚本，按顺序执行）
     * @param {string} jsUrl - JS 文件路径
     */
    _injectJS(jsUrl) {
        return new Promise((resolve, reject) => {
            // 检查是否已存在相同脚本
            const existing = document.querySelector(`script[src="${jsUrl}"]`);
            if (existing) {
                console.log(`[TabManager] JS 已存在: ${jsUrl}`);
                resolve();
                return;
            }

            const script = document.createElement('script');
            script.src = jsUrl;
            script.onload = () => {
                console.log(`[TabManager] JS 加载成功: ${jsUrl}`);
                resolve();
            };
            script.onerror = (e) => {
                console.error(`[TabManager] JS 加载失败: ${jsUrl}`, e);
                reject(new Error(`JS 加载失败: ${jsUrl}`));
            };
            document.head.appendChild(script);
        });
    },

    /**
     * 卸载 Tab（可选，用于释放资源）
     * @param {string} tabId
     */
    unload(tabId) {
        if (!this._loadedTabs.has(tabId)) return;
        const container = document.getElementById(tabId);
        if (container) container.innerHTML = '';
        this._loadedTabs.delete(tabId);
        console.log(`[TabManager] Tab ${tabId} 已卸载`);
    }
};

// 注册模式 Tab 的资源路径配置
const REGISTER_TAB_CONFIG = {
    containerId: 'page-register',
    htmlUrl: 'registration/template.html',
    cssUrls: [
        'registration/css/layout.css',
        'registration/css/form.css',
        'registration/css/pill.css',
        'registration/css/section.css',
        'registration/css/button.css'
    ],
    // 注册模式依赖的 JS 模块（按依赖顺序）
    jsUrls: [
        'registration/register_state.js',
        'registration/register_api.js',
        'registration/register_config.js',
        'registration/icons.js',
        'registration/utils.js',
        'registration/cards/basic.js',
        'registration/cards/identity.js',
        'registration/cards/executor.js',
        'registration/cards/chrome.js',
        'registration/cards/provider.js',
        'registration/cards/summary.js',
        'registration/cards/status.js',
        'registration/cards/log.js',
        'registration/tab_register.js'
    ],
    onLoaded: () => {
        if (window.RegisterApp) window.RegisterApp.init();
    }
};

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
window.TabManager = TabManager; // 暴露 TabManager

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
            // 【重构】使用 TabManager 按需加载注册模式
            if (page === 'register') {
                TabManager.load(
                    REGISTER_TAB_CONFIG.containerId,
                    REGISTER_TAB_CONFIG.htmlUrl,
                    REGISTER_TAB_CONFIG.cssUrls,
                    REGISTER_TAB_CONFIG.onLoaded,
                    REGISTER_TAB_CONFIG.jsUrls
                );
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

/**
 * 服务控制台模块 (tab_service.js)
 * ==============================
 * 负责 page-service 的所有 UI 交互和状态同步
 *
 * 负责 page-service 的所有 UI 交互和状态同步
 */

const TabService = {
    _initialized: false,
    _statusCheckTimer: null,

    init: function() {
        if (this._initialized) return;
        this._initialized = true;

        this._bindEvents();
        this._subscribeEvents();

        // 立即检查一次服务状态
        this._checkServer();

        // 每 5 秒轮询一次服务状态
        this._statusCheckTimer = setInterval(() => {
            this._checkServer();
        }, 5000);

        console.log('[tab_service.js] 模块初始化完成');
    },

    _bindEvents: function() {
        const clearBtn = document.getElementById('clearLogsBtn');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => this.clearLogs());
        }
    },

    _subscribeEvents: function() {
        // 服务上线
        EventBus.on('server:online', (health) => {
            console.log('[TabService] 收到 server:online', health);
            AppState.setServerRunning(true);
            if (health.ws_url) AppState.setWsUrl(health.ws_url);
            this.updateServerUI(true);
            this.addLog('服务已就绪: ' + (health.ws_url || 'ws://127.0.0.1:8765/ws'), 'success');
            document.getElementById('wsUrl').textContent = health.ws_url || 'ws://127.0.0.1:8765/ws';
        });

        // 服务离线
        EventBus.on('server:offline', () => {
            console.log('[TabService] 收到 server:offline');
            AppState.setServerRunning(false);
            this.updateServerUI(false);
        });

        // WebSocket 连接成功
        EventBus.on('ws:open', () => {
            this.addLog('WebSocket 连接已建立', 'success');
        });

        // WebSocket 断开
        EventBus.on('ws:close', () => {
            this.addLog('WebSocket 连接已断开，正在重连...', 'warning');
        });

        // 通用日志
        EventBus.on('log', (data) => {
            this.addLog(data.message, data.type || 'info');
        });

        // 文件处理进度
        EventBus.on('progress:files', (data) => {
            console.log('[TabService] 文件处理进度:', data);
        });

        console.log('[tab_service.js] EventBus 事件已订阅');
    },

    /**
     * 检查服务状态
     */
    _checkServer: async function() {
        window.httpClient.get('/health').then(health => {
            if (health.status === 'ok') {
                if (!AppState.serverRunning) {
                    EventBus.emit('server:online', health);
                }
            } else {
                if (AppState.serverRunning) {
                    EventBus.emit('server:offline');
                }
            }
        }).catch(() => {
            if (AppState.serverRunning) {
                EventBus.emit('server:offline');
            }
        });
    },

    /**
     * 更新服务 UI 状态
     */
    updateServerUI: function(running) {
        const dot = document.getElementById('statusDot');
        const text = document.getElementById('statusText');

        if (running) {
            dot.classList.add('online');
            text.textContent = '在线';
            text.style.color = '#3fb950';
        } else {
            dot.classList.remove('online');
            text.textContent = '离线';
            text.style.color = '#8b949e';
        }
    },

    /**
     * 添加日志条目
     */
    addLog: function(message, type = 'info') {
        const panel = document.getElementById('logPanel');
        if (!panel) return;

        const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        const div = document.createElement('div');
        div.className = 'log-line log-' + type;
        div.textContent = time + '  ' + message;
        panel.appendChild(div);
        panel.scrollTop = panel.scrollHeight;
    },

    /**
     * 清空日志
     */
    clearLogs: function() {
        const panel = document.getElementById('logPanel');
        if (panel) panel.innerHTML = '';
    },

    /**
     * 获取服务运行状态
     */
    isServerRunning: function() {
        return AppState.serverRunning;
    }
};

// 确保 TabService 在 init 前已挂到 window（app.js 导入时会执行这里）
window.TabService = TabService;

// 命名导出（供 app.js 使用）
export { TabService };

/**
 * 服务控制台模块 (tab_service.js)
 * ==============================
 * 负责 page-service 的所有 UI 交互和状态同步
 *
 * 负责 page-service 的所有 UI 交互和状态同步
 */

const TabService = {
    _initialized: false,

    init: function() {
        if (this._initialized) return;
        this._initialized = true;

        this._bindEvents();
        this._subscribeEvents();

        console.log('[tab_service.js] 模块初始化完成');
    },

    _bindEvents: function() {
        const clearBtn = document.getElementById('clearLogsBtn');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => this.clearLogs());
        }

        const startBtn = document.getElementById('startBtn');
        if (startBtn) {
            startBtn.addEventListener('click', () => {
                const host = document.getElementById('hostInput').value || '127.0.0.1';
                const port = parseInt(document.getElementById('portInput').value) || 8765;

                startBtn.disabled = true;
                API.call(AppState.serverRunning ? 'stop_server' : 'start_server', { host, port });
            });
        }
    },

    _subscribeEvents: function() {
        EventBus.on('server:start', (result) => {
            if (result.success) {
                AppState.setServerRunning(true);
                this.updateServerUI(true);
                this.addLog('连接服务已就绪，网关已开启', 'success');
                this.addLog('服务地址: ' + result.ws_url, 'info');
            }
        });

        EventBus.on('server:stop', () => {
            AppState.setServerRunning(false);
            this.updateServerUI(false);
            this.addLog('连接服务已断开', 'info');
        });

        EventBus.on('server:online', (health) => {
            AppState.setServerRunning(true);
            if (health.ws_url) AppState.setWsUrl(health.ws_url);
            this.updateServerUI(true);
            document.getElementById('wsUrl').textContent = health.ws_url || 'ws://127.0.0.1:8765/ws';
        });

        EventBus.on('server:offline', () => {
            AppState.setServerRunning(false);
            this.updateServerUI(false);
        });

        EventBus.on('progress:start_server', (data) => {
            this.addLog(data.message, 'info');
        });

        EventBus.on('error:start_server', (data) => {
            this.addLog('启动失败: ' + data.error, 'error');
            this._resetStartButton();
        });

        EventBus.on('log', (data) => {
            this.addLog(data.message, data.type || 'info');
        });

        EventBus.on('ws:open', () => {
            this.addLog('WebSocket 连接已建立', 'success');
        });

        EventBus.on('ws:close', () => {
            this.addLog('WebSocket 连接已断开，正在重连...', 'warning');
        });
    },

    /**
     * 更新服务 UI 状态
     */
    updateServerUI: function(running) {
        const dot = document.getElementById('statusDot');
        const text = document.getElementById('statusText');
        const btn = document.getElementById('startBtn');

        if (running) {
            dot.classList.add('online');
            text.textContent = '在线';
            text.style.color = '#3fb950';
            if (btn) {
                btn.innerHTML = `
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                    </svg>
                    停止服务
                `;
                btn.classList.add('running');
                btn.disabled = false;
            }
        } else {
            dot.classList.remove('online');
            text.textContent = '离线';
            text.style.color = '#8b949e';
            if (btn) {
                btn.innerHTML = `
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                        <polygon points="5 3 19 12 5 21 5 3"/>
                    </svg>
                    启动服务
                `;
                btn.classList.remove('running');
                btn.disabled = false;
            }
        }
    },

    _resetStartButton: function() {
        const btn = document.getElementById('startBtn');
        if (btn) btn.disabled = false;
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

export { TabService };

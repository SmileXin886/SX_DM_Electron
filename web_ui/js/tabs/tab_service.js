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

        // 还原启动按钮的控制逻辑
        const startBtn = document.getElementById('startBtn');
        if (startBtn) {
            startBtn.addEventListener('click', async () => {
                const host = document.getElementById('hostInput').value || '127.0.0.1';
                const port = document.getElementById('portInput').value || '8765';

                // 禁用按钮防抖
                startBtn.disabled = true;

                if (AppState.serverRunning) {
                    this.addLog('正在发送停止指令...', 'info');
                    await window.electronAPI.stopServer();
                } else {
                    this.addLog('正在启动服务...', 'info');
                    await window.electronAPI.startServer(host, port);
                }

                // 按钮状态会通过 _checkServer 轮询检测到状态变化后自动恢复
            });
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

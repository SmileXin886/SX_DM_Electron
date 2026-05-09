/**
 * 服务控制台模块 (tab_service.js)
 * ==============================
 * 负责 page-service 的所有 UI 交互和状态同步
 *
 * 【新架构】
 * - Python server.py 由 Electron 常驻守护，无需前端启停
 * - 插件对接网关：通过 HTTP /api/gateway/start/stop 软开关控制
 * - 状态指示灯：监听 WebSocket 广播 GATEWAY_STATUS 更新（无需轮询）
 */

const TabService = {
    _initialized: false,
    _gatewayEnabled: false,
    _lastLoggedState: null, // 记录上一次日志输出的状态，避免重复日志

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

        // 启动/停止按钮 → 切换网关软开关
        const toggleBtn = document.getElementById('startBtn');
        if (toggleBtn) {
            toggleBtn.addEventListener('click', () => this._toggleGateway());
        }
    },

    _subscribeEvents: function() {
        // 网关状态由 WebSocket 广播推送（只在状态真正变化时输出日志）
        EventBus.on('gateway:status', (data) => {
            const prevState = this._gatewayEnabled;
            this._gatewayEnabled = data.enabled;
            this.updateServerUI(data.enabled);
            // 只在状态真正发生变化时记录日志
            if (prevState !== data.enabled) {
                this.addLog(
                    data.enabled ? '网关已开启，插件可对接' : '网关已关闭，插件无法连接',
                    data.enabled ? 'success' : 'info'
                );
            }
        });

        // 网关切换成功（主动触发时响应）
        EventBus.on('gateway:changed', (data) => {
            const prevState = this._gatewayEnabled;
            this._gatewayEnabled = data.enabled;
            this.updateServerUI(data.enabled);
            // 只在状态真正变化时输出
            if (prevState !== data.enabled) {
                this.addLog(
                    data.enabled ? '网关已开启' : '网关已关闭',
                    data.enabled ? 'success' : 'warning'
                );
            }
            // 网关开启时自动连接 WebSocket
            if (data.enabled) {
                window.wsClient.connect();
            }
        });

        // Python 服务离线
        EventBus.on('server:offline', () => {
            const wasOnline = this._gatewayEnabled;
            this._gatewayEnabled = false;
            this.updateServerUI(false);
            if (wasOnline) {
                this.addLog('Python 服务离线', 'error');
            }
        });

        // WebSocket 连接/断开
        EventBus.on('ws:open', () => {
            this.addLog('WebSocket 连接已建立', 'success');
        });

        EventBus.on('ws:close', () => {
            this.addLog('WebSocket 连接已断开，正在重连...', 'warning');
        });

        EventBus.on('log', (data) => {
            this.addLog(data.message, data.type || 'info');
        });
    },

    /**
     * 切换网关开关
     */
    _toggleGateway: async function() {
        const btn = document.getElementById('startBtn');
        if (btn) btn.disabled = true;

        try {
            const result = await window.API.gatewayToggle(this._gatewayEnabled);
            if (!result.success) {
                this.addLog('切换失败: ' + (result.error || '未知错误'), 'error');
            }
        } catch (e) {
            this.addLog('切换失败: ' + e.message, 'error');
        } finally {
            if (btn) btn.disabled = false;
        }
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
     * 获取网关状态
     */
    isServerRunning: function() {
        return this._gatewayEnabled;
    }
};

export { TabService };

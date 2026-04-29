/**
 * 中央通信层 (api.js)
 * ==================
 * 统一管理所有与后端的通信交互。
 *
 * 【新架构通信宪法】
 * - 系统级操作（文件对话框）：window.electronAPI.xxx() → Electron main.js
 * - 业务逻辑操作（文件处理、预设 CRUD）：fetch() → Python FastAPI
 * - 实时推送：WebSocket → Python FastAPI
 *
 * 【旧→新对照表】
 *   window.pyBridge.receiveMessage(...)  →  API.call(action, params)
 *   window.pyBridge.open_file_dialog()   →  window.electronAPI.openFileDialog()
 *   window.pyBridge.remove_file(idx)     →  fetch DELETE /api/files/{idx}
 *   signal_result/signal_progress        →  EventBus 事件 + WebSocket
 */

(function() {
    'use strict';

    console.log('[api.js] 通信层加载中...');

    // ===== 常量 =====
    const API_BASE = 'http://127.0.0.1:8765';
    const WS_BASE = 'ws://127.0.0.1:8765';

    // 文件扩展名映射
    const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp']);
    const VIDEO_EXTS = new Set(['.mp4', '.avi', '.mov', '.mkv', '.webm', '.flv']);
    const AUDIO_EXTS = new Set(['.mp3', '.wav', '.aac', '.flac', '.ogg', '.m4a']);

    /**
     * 根据文件路径判断类型
     */
    function getFileType(filePath) {
        const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
        if (IMAGE_EXTS.has(ext)) return 'image';
        if (VIDEO_EXTS.has(ext)) return 'video';
        if (AUDIO_EXTS.has(ext)) return 'audio';
        return 'unknown';
    }

    /**
     * 前端媒体解析（Electron 环境，文件协议可用）
     * image  → 直接用 file:// URL 作为缩略图
     * video  → 创建 <video> 读取时长，用 canvas 截帧
     * audio  → 创建 <audio> 读取时长
     */
    async function extractMediaInfo(filePath) {
        const type = getFileType(filePath);
        const name = filePath.split(/[\\/]/).pop();
        const url = 'file:///' + filePath.replace(/\\/g, '/');

        const info = {
            type,
            path: filePath,
            name,
            url,
            duration: '00:00',
            duration_seconds: 0,
            thumbnail_base64: url,
        };

        if (type === 'unknown') return info;

        if (type === 'image') {
            // 图片不需要额外处理，url 即为缩略图
            return info;
        }

        if (type === 'video') {
            try {
                const metadata = await _getVideoMetadata(url);
                info.duration = metadata.duration;
                info.duration_seconds = metadata.durationSeconds;
                info.thumbnail_base64 = metadata.thumbnail || url;
            } catch (e) {
                console.warn('[API] 视频解析失败:', e);
            }
            return info;
        }

        if (type === 'audio') {
            try {
                const metadata = await _getAudioMetadata(url);
                info.duration = metadata.duration;
                info.duration_seconds = metadata.durationSeconds;
            } catch (e) {
                console.warn('[API] 音频解析失败:', e);
            }
            return info;
        }

        return info;
    }

    function _getVideoMetadata(src) {
        return new Promise((resolve, reject) => {
            const video = document.createElement('video');
            video.preload = 'metadata';
            video.muted = true;

            const timeout = setTimeout(() => {
                if (video.parentNode) video.remove();
                reject(new Error('video timeout'));
            }, 15000);

            video.onloadedmetadata = () => {
                clearTimeout(timeout);
                const dur = video.duration;
                const h = Math.floor(dur / 60);
                const m = Math.floor(dur % 60);
                const durationStr = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');

                // 尝试截取第0帧
                _captureVideoFrame(video).then(thumbnail => {
                    video.remove();
                    resolve({ duration: durationStr, durationSeconds: dur, thumbnail });
                }).catch(() => {
                    video.remove();
                    resolve({ duration: durationStr, durationSeconds: dur, thumbnail: '' });
                });
            };

            video.onerror = () => {
                clearTimeout(timeout);
                video.remove();
                reject(new Error('video load error'));
            };

            video.src = src;
        });
    }

    function _captureVideoFrame(video) {
        return new Promise((resolve, reject) => {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = 320;
                canvas.height = 180;
                const ctx = canvas.getContext('2d');
                video.currentTime = 0;
                video.onseeked = () => {
                    try {
                        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                        resolve(canvas.toDataURL('image/jpeg', 0.7));
                    } catch (e) {
                        reject(e);
                    }
                };
            } catch (e) {
                reject(e);
            }
        });
    }

    function _getAudioMetadata(src) {
        return new Promise((resolve, reject) => {
            const audio = document.createElement('audio');
            audio.preload = 'metadata';

            const timeout = setTimeout(() => {
                if (audio.parentNode) audio.remove();
                reject(new Error('audio timeout'));
            }, 15000);

            audio.onloadedmetadata = () => {
                clearTimeout(timeout);
                const dur = audio.duration;
                const h = Math.floor(dur / 60);
                const m = Math.floor(dur % 60);
                audio.remove();
                resolve({
                    duration: String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0'),
                    durationSeconds: dur,
                });
            };

            audio.onerror = () => {
                clearTimeout(timeout);
                audio.remove();
                reject(new Error('audio load error'));
            };

            audio.src = src;
        });
    }

    /**
     * 批量解析媒体文件（并发，带进度回调）
     * @param {string[]} filePaths
     * @param {Function} onProgress (index, total) => void
     */
    async function extractAllMediaInfo(filePaths, onProgress) {
        const results = [];
        for (let i = 0; i < filePaths.length; i++) {
            const info = await extractMediaInfo(filePaths[i]);
            results.push(info);
            if (onProgress) onProgress(i + 1, filePaths.length);
        }
        return results;
    }

    // ===== 事件总线 =====
    const EventBus = {
        _listeners: {},

        on: function(event, callback) {
            if (!this._listeners[event]) this._listeners[event] = [];
            this._listeners[event].push(callback);
        },

        off: function(event, callback) {
            if (!this._listeners[event]) return;
            this._listeners[event] = this._listeners[event].filter(cb => cb !== callback);
        },

        emit: function(event, data) {
            if (!this._listeners[event]) return;
            this._listeners[event].forEach(cb => {
                try { cb(data); } catch (e) { console.error('[EventBus]', event, e); }
            });
        }
    };

    window.EventBus = EventBus;


    // ===== WebSocket 客户端 =====
    let _ws = null;
    let _wsReconnectTimer = null;
    let _wsReady = false;

    function wsConnect() {
        if (_ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)) return;

        try {
            _ws = new WebSocket(WS_BASE + '/ws');
        } catch (e) {
            console.error('[WS] 创建失败:', e);
            return;
        }

        _ws.onopen = () => {
            console.log('[WS] 连接已建立');
            _wsReady = true;
            EventBus.emit('ws:open');
            if (_wsReconnectTimer) { clearTimeout(_wsReconnectTimer); _wsReconnectTimer = null; }
        };

        _ws.onmessage = (evt) => {
            try {
                const msg = JSON.parse(evt.data);
                console.log('[WS] 收到消息:', msg);
                _routeWsMessage(msg);
            } catch (e) {
                console.error('[WS] 解析失败:', e);
            }
        };

        _ws.onclose = () => {
            console.log('[WS] 连接已关闭');
            _wsReady = false;
            EventBus.emit('ws:close');
            // 3秒后自动重连
            if (!_wsReconnectTimer) {
                _wsReconnectTimer = setTimeout(() => {
                    _wsReconnectTimer = null;
                    wsConnect();
                }, 3000);
            }
        };

        _ws.onerror = (err) => {
            console.error('[WS] 错误:', err);
        };
    }

    function wsSend(data) {
        if (!_ws || _ws.readyState !== WebSocket.OPEN) {
            console.warn('[WS] 未连接，消息被丢弃:', data);
            return false;
        }
        _ws.send(JSON.stringify(data));
        return true;
    }

    function _routeWsMessage(msg) {
        // 格式: { type: 'LOG'|'PRESETS_UPDATED'|'PROGRESS', ... }
        const type = msg.type || msg.action || '';
        if (type === 'LOG') {
            EventBus.emit('log', { message: msg.message || '', type: msg.level || 'info' });
        } else if (type === 'PRESETS_UPDATED') {
            EventBus.emit('presets:updated', msg.data || {});
        } else if (type === 'PROGRESS') {
            EventBus.emit('progress:' + (msg.task_id || 'any'), {
                taskId: msg.task_id,
                percent: msg.percent,
                message: msg.message
            });
        } else {
            EventBus.emit('ws:message:' + type, msg);
        }
    }

    window.wsClient = {
        connect: wsConnect,
        send: wsSend,
        isReady: () => _wsReady
    };


    // ===== HTTP 客户端 =====
    async function httpGet(path) {
        const res = await fetch(API_BASE + path, { method: 'GET' });
        if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + res.statusText);
        return res.json();
    }

    async function httpPost(path, body) {
        const res = await fetch(API_BASE + path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + res.statusText);
        return res.json();
    }

    async function httpDelete(path) {
        const res = await fetch(API_BASE + path, { method: 'DELETE' });
        if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + res.statusText);
        return res.json();
    }

    window.httpClient = {
        get: httpGet,
        post: httpPost,
        delete: httpDelete
    };


    // ===== API 核心对象（调用入口）=====
    const API = {
        _bridgeReady: false,

        init: function() {
            this._waitForElectron();
        },

        /**
         * 【核心修复】PySide6 风格的统一调用入口
         * 系统级操作（启动/停止服务）→ Electron main.js
         * 业务指令 → 映射到现有方法
         */
        async call(action, params = {}) {
            console.log(`[API.call] 操作: ${action}`, params);

            switch (action) {
                case 'start_server': {
                    try {
                        EventBus.emit('progress:start_server', { percent: 30, message: '正在尝试建立连接服务...' });
                        await window.electronAPI.startServer(params.host || '127.0.0.1', params.port || 8765);
                        setTimeout(() => this._checkServerStatus('start_server'), 1000);
                        return { success: true };
                    } catch (e) {
                        console.error('[API.call] 启动服务失败:', e);
                        EventBus.emit('error:start_server', { error: '连接服务启动失败' });
                        return { success: false, error: e.message };
                    }
                }

                case 'stop_server': {
                    try {
                        EventBus.emit('log', { message: '正在安全断开连接服务...', type: 'info' });
                        await window.electronAPI.stopServer();
                        this._onServerOffline();
                        return { success: true };
                    } catch (e) {
                        console.error('[API.call] 停止服务失败:', e);
                        return { success: false, error: e.message };
                    }
                }

                case 'get_presets':
                    return await this.getPresets();

                case 'open_file_dialog':
                    return this.openAndProcessFiles();

                default:
                    console.warn(`[API.call] 未知操作: ${action}`);
                    return { success: false, error: `unknown action: ${action}` };
            }
        },

        _checkServerStatus: async function(triggeringAction) {
            try {
                const health = await httpGet('/health');
                console.log('[API] 服务状态:', health);
                if (health.status === 'ok') {
                    if (triggeringAction === 'start_server') {
                        EventBus.emit('server:start', {
                            success: true,
                            ws_url: health.ws_url || `ws://127.0.0.1:8765/ws`
                        });
                    }
                    // 避免 bridge:ready 时自动触发 server:online（会导致日志重复）
                    // server:online 仅在 WebSocket 自动重连场景下由 ws:open 事件处理
                } else {
                    EventBus.emit('server:offline');
                }
            } catch (e) {
                if (triggeringAction !== 'stop_server') {
                    EventBus.emit('server:offline');
                    EventBus.emit('server:stop', { success: true });
                }
            }
        },

        _onServerOffline: function() {
            EventBus.emit('server:offline');
            EventBus.emit('server:stop', { success: true });
        },

        _waitForElectron: function() {
            let attempts = 0;
            const maxAttempts = 50;

            const check = () => {
                attempts++;
                if (window.electronAPI) {
                    console.log('[API] electronAPI 已就绪');
                    this._bridgeReady = true;
                    wsConnect();
                    EventBus.emit('bridge:ready');
                    this._checkServerStatus();
                    return;
                }
                if (attempts < maxAttempts) {
                    setTimeout(check, 100);
                } else {
                    console.error('[API] electronAPI 连接超时（未在 Electron 环境中运行？）');
                    EventBus.emit('bridge:error', { message: 'electronAPI 不可用' });
                }
            };

            check();
        },


        // ============ 文件管理 ============

        /**
         * 处理新文件（打开对话框 + 上传到后端）
         */
        async openAndProcessFiles() {
            if (!window.electronAPI) {
                console.error('[API] electronAPI 不可用');
                return;
            }

            const result = await window.electronAPI.openFileDialog({
                title: '选择素材文件',
                filters: [
                    { name: '媒体文件', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'mp4', 'avi', 'mov', 'mkv', 'webm', 'mp3', 'wav', 'aac', 'flac', 'ogg', 'm4a'] },
                    { name: '所有文件', extensions: ['*'] }
                ],
                properties: ['openFile', 'multiSelections']
            });

            if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
                console.log('[API] 文件选择已取消');
                return;
            }

            console.log('[API] 已选择', result.filePaths.length, '个文件:', result.filePaths);
            await this.processFiles(result.filePaths);
        },

        /**
         * 将文件路径发送给后端处理（优先 Electron IPC）
         */
        async processFiles(paths) {
            try {
                EventBus.emit('progress:files', { percent: 0, message: '正在解析媒体信息...' });
                const enrichedFiles = await extractAllMediaInfo(paths, (idx, total) => {
                    const pct = Math.round(idx / total * 90);
                    EventBus.emit('progress:files', { percent: pct, message: `已解析 ${idx}/${total} 个文件` });
                });

                EventBus.emit('progress:files', { percent: 95, message: '正在提交...' });
                let result;
                try {
                    result = await window.electronAPI.addFiles(enrichedFiles);
                    if (!result || result.success === false) throw new Error('IPC failed');
                    console.log('[API] 文件处理结果（IPC）:', result);
                } catch (e) {
                    // 降级：HTTP
                    result = await httpPost('/api/files/process', { files: enrichedFiles });
                    console.log('[API] 文件处理结果（HTTP）:', result);
                }
                EventBus.emit('progress:files', { percent: 100, message: '完成' });
                EventBus.emit('files:processed', result);
                EventBus.emit('files:listUpdated', result.files || []);
            } catch (e) {
                console.error('[API] 文件处理失败:', e);
                EventBus.emit('error:files', { error: e.message });
            }
        },

        /**
         * 获取当前文件列表（优先 Electron IPC）
         */
        async getFiles() {
            try {
                const result = await window.electronAPI.getFiles();
                if (result && result.success !== false) {
                    return result.files || [];
                }
                // 降级：HTTP
                const httpResult = await httpGet('/api/files');
                return httpResult.files || [];
            } catch (e) {
                console.error('[API] 获取文件列表失败:', e);
                return [];
            }
        },

        /**
         * 删除文件（优先 Electron IPC）
         */
        async removeFile(index) {
            try {
                let result;
                try {
                    result = await window.electronAPI.removeFile(index);
                    if (!result || result.success === false) throw new Error('IPC failed');
                    console.log('[API] 删除文件结果（IPC）:', result);
                } catch (e) {
                    // 降级：HTTP
                    result = await httpDelete('/api/files/' + index);
                    console.log('[API] 删除文件结果（HTTP）:', result);
                }
                EventBus.emit('file:removed', { index });
                EventBus.emit('files:listUpdated', result.files || []);
                return result;
            } catch (e) {
                console.error('[API] 删除文件失败:', e);
                EventBus.emit('error:files', { error: e.message });
            }
        },

        /**
         * 处理编辑区拖拽的文件（优先 Electron IPC）
         */
        async processEditorDropFiles(paths, dropPos) {
            try {
                const enrichedFiles = await extractAllMediaInfo(paths);
                let result;
                try {
                    result = await window.electronAPI.addFiles(enrichedFiles);
                    if (!result || result.success === false) throw new Error('IPC failed');
                } catch (e) {
                    result = await httpPost('/api/files/process', { files: enrichedFiles, for_editor: true });
                }
                console.log('[API] 编辑区拖拽处理结果:', result);
                if (result.files && result.files.length > 0) {
                    EventBus.emit('files:dropped', {
                        files: result.files,
                        drop_pos: dropPos
                    });
                    EventBus.emit('files:listUpdated', result.files || []);
                }
            } catch (e) {
                console.error('[API] 编辑区拖拽处理失败:', e);
            }
        },


        // ============ 预设管理 ============

    /**
     * 获取预设列表（优先 Electron IPC，无需 FastAPI 服务）
     */
    async getPresets() {
        try {
            const result = await window.electronAPI.getPresets();
            if (result && result.success) {
                return result.presets || [];
            }
            // 降级：尝试 HTTP
            const httpResult = await httpGet('/api/presets');
            return httpResult.presets || [];
        } catch (e) {
            console.error('[API] 获取预设失败:', e);
            return [];
        }
    },

    /**
     * 创建预设（优先 Electron IPC）
     */
    async createPreset(config) {
        try {
            const result = await window.electronAPI.createPreset(config);
            if (result && result.success) {
                console.log('[API] 创建预设结果（IPC）:', result);
                EventBus.emit('preset:created', result);
                return result;
            }
            // 降级：尝试 HTTP
            const httpResult = await httpPost('/api/presets', config);
            console.log('[API] 创建预设结果（HTTP）:', httpResult);
            EventBus.emit('preset:created', httpResult);
            return httpResult;
        } catch (e) {
            console.error('[API] 创建预设失败:', e);
            EventBus.emit('error:preset', { error: e.message });
        }
    },

    /**
     * 应用预设（仅查询，不需要写操作，走 HTTP）
     */
    async applyPreset(id) {
        try {
            const result = await httpPost('/api/presets/' + id + '/apply', {});
            console.log('[API] 应用预设结果:', result);
            EventBus.emit('preset:applied', result);
            return result;
        } catch (e) {
            console.error('[API] 应用预设失败:', e);
            EventBus.emit('error:preset', { error: e.message });
        }
    },

    /**
     * 删除预设（优先 Electron IPC）
     */
    async deletePreset(id) {
        try {
            const result = await window.electronAPI.deletePreset(id);
            if (result && result.success !== false) {
                console.log('[API] 删除预设结果（IPC）:', result);
                EventBus.emit('preset:deleted', result);
                return result;
            }
            // 降级：尝试 HTTP
            const httpResult = await httpDelete('/api/presets/' + id);
            console.log('[API] 删除预设结果（HTTP）:', httpResult);
            EventBus.emit('preset:deleted', httpResult);
            return httpResult;
        } catch (e) {
            console.error('[API] 删除预设失败:', e);
            EventBus.emit('error:preset', { error: e.message });
        }
    },


        // ============ WebSocket 发送 ============

        /**
         * 通过 WebSocket 发送通用消息
         */
        wsSend: wsSend,

        /**
         * 检查 Bridge 是否就绪
         */
        isReady: function() {
            return this._bridgeReady;
        }
    };

    window.API = API;

    console.log('[api.js] 通信层已加载 (HTTP + WebSocket 模式)');

})();

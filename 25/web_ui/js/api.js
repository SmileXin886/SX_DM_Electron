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
        const url = 'app-media://local/' + filePath.replace(/\\/g, '/');
        console.log('[API.extractMediaInfo]', { filePath, type, name, url });

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
            return info;
        }

        if (type === 'video') {
            try {
                const metadata = await _getVideoMetadata(url);
                info.duration = metadata.duration;
                info.duration_seconds = metadata.durationSeconds;
                info.thumbnail_base64 = metadata.thumbnail || url;
            } catch (e) {
                console.warn('[API] 视频解析失败:', e.message, 'url:', url);
            }
            return info;
        }

        if (type === 'audio') {
            try {
                const metadata = await _getAudioMetadata(url);
                info.duration = metadata.duration;
                info.duration_seconds = metadata.durationSeconds;
            } catch (e) {
                console.warn('[API] 音频解析失败:', e.message, 'url:', url);
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
                // 动态使用视频原始宽高，保持比例不拉伸
                let vw = video.videoWidth || 320;
                let vh = video.videoHeight || 180;
                const maxSize = 320;
                if (vw > maxSize || vh > maxSize) {
                    const scale = maxSize / Math.max(vw, vh);
                    vw = Math.round(vw * scale);
                    vh = Math.round(vh * scale);
                }
                canvas.width = vw;
                canvas.height = vh;
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
    let _wsAutoReconnect = false; // 网关开启时才自动重连

    function wsConnect() {
        if (_ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)) return;
        if (!_wsAutoReconnect) return; // 网关未开启时不尝试连接

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
            // 网关开启时自动重连
            if (_wsAutoReconnect && !_wsReconnectTimer) {
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

    function wsEnableAutoReconnect() {
        _wsAutoReconnect = true;
        wsConnect();
    }

    function wsDisableAutoReconnect() {
        _wsAutoReconnect = false;
        if (_wsReconnectTimer) { clearTimeout(_wsReconnectTimer); _wsReconnectTimer = null; }
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
        // 格式: { type: 'LOG'|'GATEWAY_STATUS'|'PRESETS_UPDATED'|'PROGRESS', ... }
        const type = msg.type || msg.action || '';
        if (type === 'LOG') {
            EventBus.emit('log', { message: msg.message || '', type: msg.level || 'info' });
        } else if (type === 'GATEWAY_STATUS') {
            EventBus.emit('gateway:status', {
                enabled: msg.gateway_enabled,
                wsConnections: msg.websocket_connections,
            });
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
        connect: wsEnableAutoReconnect,
        disconnect: wsDisableAutoReconnect,
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
        _serverPollingTimer: null,

        init: function() {
            this._waitForElectron();
            // 不再轮询，改为监听 WebSocket 广播的 GATEWAY_STATUS
        },


        // ============ 网关软开关（插件对接控制）============

        /**
         * 开启网关（允许 WebSocket 连接）
         */
        async gatewayStart() {
            try {
                const result = await httpPost('/api/gateway/start', {});
                if (result.success) {
                    EventBus.emit('gateway:changed', { enabled: true });
                }
                return result;
            } catch (e) {
                console.error('[API] 开启网关失败:', e);
                return { success: false, error: e.message };
            }
        },

        /**
         * 关闭网关（拒绝 WebSocket 连接）
         */
        async gatewayStop() {
            try {
                // 先关闭 WebSocket
                if (_ws) {
                    _ws.close();
                    _ws = null;
                }
                wsDisableAutoReconnect();
                const result = await httpPost('/api/gateway/stop', {});
                if (result.success) {
                    EventBus.emit('gateway:changed', { enabled: false });
                }
                return result;
            } catch (e) {
                console.error('[API] 关闭网关失败:', e);
                return { success: false, error: e.message };
            }
        },

        /**
         * 切换网关开关
         */
        async gatewayToggle(currentEnabled) {
            if (currentEnabled) {
                return await this.gatewayStop();
            } else {
                return await this.gatewayStart();
            }
        },


        // ============ 服务状态轮询 ============

        /**
         * 轮询服务状态，更新 UI 指示灯
         */
        _pollServerStatus: async function() {
            try {
                const status = await httpGet('/api/gateway/status');
                const running = status.gateway_enabled || false;
                EventBus.emit('gateway:status', {
                    enabled: running,
                    wsConnections: status.websocket_connections || 0,
                });
            } catch (e) {
                EventBus.emit('server:offline');
            }
        },

        _startServerPolling: function() {
            // 每 3 秒轮询一次状态
            this._pollServerStatus();
            this._serverPollingTimer = setInterval(() => {
                this._pollServerStatus();
            }, 3000);
        },

        _stopServerPolling: function() {
            if (this._serverPollingTimer) {
                clearInterval(this._serverPollingTimer);
                this._serverPollingTimer = null;
            }
        },


        _waitForElectron: function() {
            let attempts = 0;
            const maxAttempts = 50;

            const check = () => {
                attempts++;
                if (window.electronAPI) {
                    console.log('[API] electronAPI 已就绪');
                    this._bridgeReady = true;
                    EventBus.emit('bridge:ready');
                    return;
                }
                if (attempts < maxAttempts) {
                    setTimeout(check, 100);
                } else {
                    console.warn('[API] electronAPI 未就绪（非 Electron 环境？）');
                    this._bridgeReady = false;
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
         * 将文件路径发送给后端处理
         * 始终走 FastAPI HTTP 服务（server.py 是常驻进程，内存状态不丢失）
         * 【多租户】携带 task_id 实现 session 隔离
         */
        async processFiles(paths) {
            try {
                EventBus.emit('progress:files', { percent: 0, message: '正在解析媒体信息...' });
                const enrichedFiles = await extractAllMediaInfo(paths, (idx, total) => {
                    const pct = Math.round(idx / total * 90);
                    EventBus.emit('progress:files', { percent: pct, message: `已解析 ${idx}/${total} 个文件` });
                });

                EventBus.emit('progress:files', { percent: 95, message: '正在提交...' });
                // 【多租户】携带 task_id
                const task_id = window.AppState.currentTaskId || 'default';
                const result = await httpPost('/api/files/process', { task_id, files: enrichedFiles });
                console.log('[API] 文件处理结果:', result, 'task_id:', task_id);

                EventBus.emit('progress:files', { percent: 100, message: '完成' });
                EventBus.emit('files:processed', result);
                EventBus.emit('files:listUpdated', result.files || []);
            } catch (e) {
                console.error('[API] 文件处理失败:', e);
                EventBus.emit('error:files', { error: e.message });
            }
        },

        /**
         * 获取当前文件列表
         * 始终走 FastAPI HTTP 服务
         * 【多租户】携带 task_id
         */
        async getFiles() {
            try {
                const task_id = window.AppState.currentTaskId || 'default';
                const result = await httpGet('/api/files?task_id=' + encodeURIComponent(task_id));
                return result.files || [];
            } catch (e) {
                console.error('[API] 获取文件列表失败:', e);
                return [];
            }
        },

        /**
         * 删除文件
         * 始终走 FastAPI HTTP 服务
         * 【多租户】携带 task_id
         */
        async removeFile(index) {
            try {
                const task_id = window.AppState.currentTaskId || 'default';
                const result = await httpDelete('/api/files/' + index + '?task_id=' + encodeURIComponent(task_id));
                // 附带被删除文件的 identity 信息，供 editor_tag_sync 精确匹配标签
                const removed = result.removed || {};
                EventBus.emit('file:removed', {
                    index: index,
                    path: removed.path || '',
                    name: removed.name || '',
                    url: removed.url || ''
                });
                EventBus.emit('files:listUpdated', result.files || []);
                return result;
            } catch (e) {
                console.error('[API] 删除文件失败:', e);
                EventBus.emit('error:files', { error: e.message });
            }
        },

        /**
         * 处理编辑区拖拽的文件
         * 始终走 FastAPI HTTP 服务
         * @param {string[]} paths - 文件路径数组
         * @param {{x: number, y: number}} dropPos - 鼠标释放位置
         * 【多租户】携带 task_id 实现 session 隔离
         */
        async processEditorDropFiles(paths, dropPos) {
            try {
                const enrichedFiles = await extractAllMediaInfo(paths);
                // 过滤掉 path 为空的无效文件
                const validFiles = enrichedFiles.filter(f => f.path && f.path.trim() !== '');
                if (validFiles.length === 0) {
                    console.warn('[API] 拖拽文件无效（path 为空）');
                    return;
                }
                // 【多租户】携带 task_id
                const task_id = window.AppState.currentTaskId || 'default';
                const result = await httpPost('/api/files/process', { task_id, files: validFiles, for_editor: true });
                console.log('[API] 编辑区拖拽处理结果:', result, 'task_id:', task_id);

                if (result.files && result.files.length > 0) {
                    // 将新文件追加到 AppState（避免引用索引错乱）
                    const existingFiles = AppState.uploadedFiles || [];
                    const newFiles = result.files.slice(existingFiles.length);
                    AppState.setUploadedFiles(result.files);

                    // 事件携带完整列表（后端已排序），同时标注本次新增的文件
                    EventBus.emit('files:dropped', {
                        files: newFiles,
                        all_files: result.files,
                        drop_pos: dropPos
                    });
                    EventBus.emit('files:listUpdated', result.files);
                }
                // 统一通过 files:processed 触发 Toast（限制提示走这里）
                if (result.message) {
                    EventBus.emit('files:processed', result);
                }
            } catch (e) {
                console.error('[API] 编辑区拖拽处理失败:', e);
            }
        },


        // ============ 预设管理（走 preset_ipc.py）============

        /**
         * 获取预设列表
         */
        async getPresets() {
            try {
                const result = await window.electronAPI.getPresets();
                if (result && result.success) {
                    return result.presets || [];
                }
                const httpResult = await httpGet('/api/presets');
                return httpResult.presets || [];
            } catch (e) {
                console.error('[API] 获取预设失败:', e);
                return [];
            }
        },

        /**
         * 创建预设
         */
        async createPreset(config) {
            try {
                const result = await window.electronAPI.createPreset(config);
                if (result && result.success) {
                    EventBus.emit('preset:created', result);
                    return result;
                }
                const httpResult = await httpPost('/api/presets', config);
                EventBus.emit('preset:created', httpResult);
                return httpResult;
            } catch (e) {
                console.error('[API] 创建预设失败:', e);
                EventBus.emit('error:preset', { error: e.message });
            }
        },

        /**
         * 应用预设
         */
        async applyPreset(id) {
            try {
                const result = await httpPost('/api/presets/' + id + '/apply', {});
                EventBus.emit('preset:applied', result);
                return result;
            } catch (e) {
                console.error('[API] 应用预设失败:', e);
                EventBus.emit('error:preset', { error: e.message });
            }
        },

        /**
         * 删除预设
         */
        async deletePreset(id) {
            try {
                const result = await window.electronAPI.deletePreset(id);
                if (result && result.success !== false) {
                    EventBus.emit('preset:deleted', result);
                    return result;
                }
                const httpResult = await httpDelete('/api/presets/' + id);
                EventBus.emit('preset:deleted', httpResult);
                return httpResult;
            } catch (e) {
                console.error('[API] 删除预设失败:', e);
                EventBus.emit('error:preset', { error: e.message });
            }
        },


        // ============ 首尾帧同步（多租户 task_id 隔离）============

        /**
         * 同步首尾帧到后端（多租户）
         * @param {string} frameType - 'first' 或 'last'
         * @param {string} filePath - 文件绝对路径
         * @param {string} name - 文件名
         */
        async processFrameFile(frameType, filePath, name) {
            const task_id = window.AppState?.currentTaskId || 'default';
            try {
                const result = await httpPost('/api/frames/process', {
                    task_id,
                    frame_type: frameType,
                    file_path: filePath,
                    name: name || filePath.split(/[\\/]/).pop(),
                });
                console.log('[API] 首尾帧同步结果:', result, 'task_id:', task_id);

                // 后端返回成功后，同步更新前端 AppState UI 状态
                if (result.success && window.AppState) {
                    const fileInfo = result.file_info;
                    window.AppState.setFrameFile(
                        frameType,
                        filePath,
                        fileInfo?.url || 'app-media://local/' + filePath.replace(/\\/g, '/')
                    );
                }

                EventBus.emit('frames:synced', result);
                return result;
            } catch (e) {
                console.error('[API] 首尾帧同步失败:', e);
                EventBus.emit('error:frames', { error: e.message });
            }
        },

        /**
         * 获取指定 task_id 的首尾帧（从后端拉取）
         */
        async getFrames() {
            const task_id = window.AppState?.currentTaskId || 'default';
            try {
                const result = await httpGet('/api/frames?task_id=' + encodeURIComponent(task_id));
                return result.frames || { first: null, last: null };
            } catch (e) {
                console.error('[API] 获取首尾帧失败:', e);
                return { first: null, last: null };
            }
        },

        /**
         * 清空指定 task_id 的首尾帧
         */
        async clearFrames() {
            const task_id = window.AppState?.currentTaskId || 'default';
            try {
                const result = await httpDelete('/api/frames?task_id=' + encodeURIComponent(task_id));
                if (result.success && window.AppState) {
                    window.AppState.clearFrames();
                }
                EventBus.emit('frames:cleared', result);
                return result;
            } catch (e) {
                console.error('[API] 清空首尾帧失败:', e);
            }
        },


        // ============ WebSocket 发送 ============

        wsSend: wsSend,

        isReady: function() {
            return this._bridgeReady;
        }
    };

    window.API = API;

    console.log('[api.js] 通信层已加载 (HTTP + WebSocket 模式)');

})();

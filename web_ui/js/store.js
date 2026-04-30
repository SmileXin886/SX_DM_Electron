/**
 * 全局状态管理中心 (store.js)
 * ============================
 * 统一管理应用的所有状态数据
 * 采用"胖服务端"原则：预设列表等关键数据由后端统一维护
 */

const AppState = {
    // ===== 服务状态 =====
    serverRunning: false,
    wsUrl: 'ws://127.0.0.1:8765/ws',
    pendingTasks: new Set(),

    // ===== Dreamina 配置 =====
    type: 'AI Video',
    model: 'Dreamina Seedance 2.0 Fast',
    mode: 'first-last',
    omniMode: 'omni',  // omni / first_last
    aspect: '16:9',
    resolution: '720P',
    duration: '10s',
    intensity: 70,
    prompt: '',

    // ===== 文件与预设 =====
    files: [],
    presets: [],
    uploadedFiles: [],  // 已上传素材列表

    // ===== 工具方法 =====

    /**
     * 添加待处理任务
     */
    addPendingTask: function(taskId) {
        this.pendingTasks.add(taskId);
    },

    /**
     * 移除待处理任务
     */
    removePendingTask: function(taskId) {
        this.pendingTasks.delete(taskId);
    },

    /**
     * 检查是否有待处理任务
     */
    hasPendingTask: function() {
        return this.pendingTasks.size > 0;
    },

    /**
     * 更新服务器运行状态
     */
    setServerRunning: function(running) {
        this.serverRunning = running;
    },

    /**
     * 更新 WebSocket URL
     */
    setWsUrl: function(url) {
        this.wsUrl = url;
    },

    /**
     * 更新预设列表
     */
    setPresets: function(presets) {
        this.presets = presets || [];
    },

    /**
     * 添加预设
     */
    addPreset: function(preset) {
        if (!this.presets.find(p => p.id === preset.id)) {
            this.presets.push(preset);
        }
    },

    /**
     * 移除预设
     */
    removePreset: function(presetId) {
        this.presets = this.presets.filter(p => p.id !== presetId);
    },

    /**
     * 更新已上传文件列表
     */
    setUploadedFiles: function(files) {
        this.uploadedFiles = files || [];
    },

    /**
     * 添加已上传文件
     */
    addUploadedFile: function(file) {
        this.uploadedFiles.push(file);
    },

    /**
     * 清空已上传文件
     */
    clearUploadedFiles: function() {
        this.uploadedFiles = [];
    },

    /**
     * 重置状态（应用启动时调用）
     */
    reset: function() {
        this.serverRunning = false;
        this.wsUrl = 'ws://127.0.0.1:8765/ws';
        this.pendingTasks.clear();
        this.presets = [];
        this.uploadedFiles = [];
    }
};

// 导出到全局
window.AppState = AppState;

console.log('[store.js] 状态管理中心已加载');

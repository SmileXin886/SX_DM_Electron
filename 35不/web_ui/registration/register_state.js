/**
 * 注册表单状态管理
 * 管理注册模式 Tab 的所有表单数据和任务状态
 */
const RegisterState = {
    // 默认表单数据
    DEFAULT_FORM: {
        platform: '',
        email: '',
        password: '',
        count: 1,
        proxy: '',
        executor_type: 'protocol',
        captcha_solver: 'auto',
        identity_provider: 'mailbox',
        oauth_provider: 'google',
        oauth_email_hint: '',
        chrome_user_data_dir: '',
        chrome_cdp_url: '',
        mail_provider: '',
        sms_provider: '',
    },

    // 当前表单数据
    _form: null,
    _platforms: [],
    _configOptions: null,
    _optionsError: '',
    _task: null,
    _polling: false,
    _logLines: [],

    // 轮询定时器引用
    _pollInterval: null,
    // 已处理的终态任务 ID 集合（防重复）
    _handledTerminalTaskIds: new Set(),
    // 已打开收银台的任务 ID 集合
    _openedCashierTaskIds: new Set(),

    init() {
        this._form = { ...this.DEFAULT_FORM };
        this._platforms = [];
        this._configOptions = null;
        this._optionsError = '';
        this._task = null;
        this._polling = false;
        this._logLines = [];
        this._handledTerminalTaskIds.clear();
        this._openedCashierTaskIds.clear();
        this._stopPolling();
    },

    // --- 表单数据读写 ---
    getForm() {
        return this._form;
    },

    setForm(data) {
        this._form = { ...this._form, ...data };
    },

    set(k, v) {
        if (this._form) {
            this._form[k] = v;
        }
    },

    get(k) {
        return this._form ? this._form[k] : undefined;
    },

    // --- 平台数据 ---
    setPlatforms(platforms) {
        this._platforms = platforms || [];
    },

    getPlatforms() {
        return this._platforms;
    },

    getCurrentPlatform() {
        if (!Array.isArray(this._platforms)) return null;
        return this._platforms.find(p => p && p.name === this._form?.platform) || null;
    },

    getPlatformOptions() {
        if (!Array.isArray(this._platforms)) return [];
        return this._platforms.map(p => ({ value: p.name, label: p.display_name }));
    },

    // --- 配置选项 ---
    setConfigOptions(options) {
        this._configOptions = options;
    },

    getConfigOptions() {
        return this._configOptions;
    },

    setOptionsError(err) {
        this._optionsError = err || '';
    },

    getOptionsError() {
        return this._optionsError;
    },

    // --- 任务状态 ---
    setTask(task) {
        this._task = task;
    },

    getTask() {
        return this._task;
    },

    setPolling(val) {
        this._polling = val;
    },

    isPolling() {
        return this._polling;
    },

    markTerminalTask(taskKey) {
        this._handledTerminalTaskIds.add(taskKey);
    },

    isTerminalTaskHandled(taskKey) {
        return this._handledTerminalTaskIds.has(taskKey);
    },

    markCashierOpened(taskKey) {
        this._openedCashierTaskIds.add(taskKey);
    },

    isCashierOpened(taskKey) {
        return this._openedCashierTaskIds.has(taskKey);
    },

    // --- 轮询控制 ---
    startPolling(intervalFn) {
        this._stopPolling();
        this._pollInterval = setInterval(intervalFn, 5000);
    },

    _stopPolling() {
        if (this._pollInterval) {
            clearInterval(this._pollInterval);
            this._pollInterval = null;
        }
    },

    // --- 日志行 ---
    addLog(level, message) {
        const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        this._logLines.push({ timestamp, level, message });
        if (this._logLines.length > 500) {
            this._logLines.shift();
        }
    },

    getLogLines() {
        return this._logLines;
    },

    clearLogs() {
        this._logLines = [];
    },

    // --- 销毁 ---
    destroy() {
        this._stopPolling();
    },
};

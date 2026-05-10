/**
 * 即梦AI标签页 - 状态管理
 * 管理账号列表、当前激活账号、授权表单数据等所有状态
 */
const JimengState = {
    // ===== 表单数据 =====
    _form: {
        cloud_token: '',
        local_token: '',
        topup_token: '',
    },

    // ===== 账号列表 =====
    _accounts: [],

    // ===== 当前激活账号（唯一） =====
    _activeAccountId: null,

    // ===== 总积分额度 =====
    _totalCredits: 0,

    // ===== UI 状态 =====
    _isAuthorizing: false,
    _authorizingType: null, // 'cloud' | 'local'

    // ===== 初始化 =====
    init() {
        this._form = { cloud_token: '', local_token: '', topup_token: '' };
        this._accounts = [];
        this._activeAccountId = null;
        this._totalCredits = 0;
        this._isAuthorizing = false;
        this._authorizingType = null;
    },

    // --- 表单数据读写 ---
    getForm() {
        return { ...this._form };
    },

    setFormField(key, value) {
        if (key in this._form) {
            this._form[key] = value;
        }
    },

    clearForm() {
        this._form = { cloud_token: '', local_token: '', topup_token: '' };
    },

    // --- 账号列表 ---
    setAccounts(accounts) {
        this._accounts = Array.isArray(accounts) ? accounts : [];
    },

    getAccounts() {
        return [...this._accounts];
    },

    addAccount(account) {
        if (!account || !account.id) return;
        const exists = this._accounts.find(a => a.id === account.id);
        if (!exists) {
            this._accounts.push(account);
        }
    },

    removeAccount(accountId) {
        this._accounts = this._accounts.filter(a => a.id !== accountId);
        if (this._activeAccountId === accountId) {
            this._activeAccountId = null;
        }
    },

    getAccountById(id) {
        return this._accounts.find(a => a.id === id) || null;
    },

    // --- 激活账号 ---
    setActiveAccountId(id) {
        this._activeAccountId = id;
    },

    getActiveAccountId() {
        return this._activeAccountId;
    },

    getActiveAccount() {
        if (!this._activeAccountId) return null;
        return this.getAccountById(this._activeAccountId);
    },

    // --- 授权状态 ---
    setAuthorizing(type) {
        this._isAuthorizing = true;
        this._authorizingType = type;
    },

    clearAuthorizing() {
        this._isAuthorizing = false;
        this._authorizingType = null;
    },

    isAuthorizing() {
        return this._isAuthorizing;
    },

    getAuthorizingType() {
        return this._authorizingType;
    },

    // --- 总积分额度 ---
    setTotalCredits(val) {
        this._totalCredits = typeof val === 'number' ? val : 0;
    },

    getTotalCredits() {
        return this._totalCredits;
    },

    // --- 销毁 ---
    destroy() {
        this.init();
    },
};

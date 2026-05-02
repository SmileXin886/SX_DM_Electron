/**
 * 即梦AI标签页 - 主入口
 * 负责初始化、DOM 事件绑定、UI 渲染和用户交互处理
 */
window.JimengApp = {

    _initialized: false,
    _consoleLines: [],

    // ============================================================
    // 初始化
    // ============================================================
    init() {
        if (this._initialized) return;
        this._initialized = true;

        JimengState.init();
        this._bindNavigation();
        this._bindConsoleClear();
        this._bindFileInput();
        this._loadAndRender();
    },

    // ============================================================
    // 数据加载
    // ============================================================
    async _loadAndRender() {
        try {
            this.log('正在加载账号数据...');
            const [accounts, activeId] = await Promise.all([
                JimengApi.getAccounts().catch(() => []),
                JimengApi.getActiveAccountId().catch(() => null),
            ]);

            JimengState.setAccounts(accounts);
            JimengState.setActiveAccountId(activeId);
            this.log('账号数据加载完成，共 ' + accounts.length + ' 个账号');
        } catch (e) {
            this.logError('加载数据失败：' + e.message);
            console.error('[JimengApp] 加载数据失败:', e);
        }

        this._renderAll();
    },

    // ============================================================
    // 全量渲染
    // ============================================================
    _renderAll() {
        this._renderAccountCount();
        this._renderAccountList();
        this._syncAuthButtons();
    },

    /**
     * 渲染账号总数
     */
    _renderAccountCount() {
        const el = document.getElementById('jm-account-count');
        if (!el) return;
        const total = JimengState.getAccounts().length;
        el.textContent = '账号总数：' + total;
    },

    /**
     * 渲染账号列表
     */
    _renderAccountList() {
        const listEl = document.getElementById('jm-account-list');
        const emptyEl = document.getElementById('jm-empty-state');
        if (!listEl) return;

        const accounts = JimengState.getAccounts();
        const activeId = JimengState.getActiveAccountId();

        if (accounts.length === 0) {
            if (emptyEl) emptyEl.style.display = '';
            return;
        }

        if (emptyEl) emptyEl.style.display = 'none';

        listEl.innerHTML = accounts.map(acc => {
            const isActive = acc.id === activeId;
            const expiresText = acc.expires_at
                ? this._formatExpires(acc.expires_at)
                : '有效期：永久';

            return `
                <div class="jm-account-item ${isActive ? 'is-active' : ''}" data-account-id="${this._escapeHtml(acc.id)}">
                    <input
                        type="radio"
                        class="jm-radio"
                        name="jm-account-radio"
                        id="jm-radio-${this._escapeHtml(acc.id)}"
                        ${isActive ? 'checked' : ''}
                        onchange="parent.JimengApp.onAccountSelect('${this._escapeHtml(acc.id)}')"
                    >
                    <div class="jm-account-info">
                        <div class="jm-account-name ${isActive ? 'is-active' : ''}">${this._escapeHtml(acc.name || acc.id)}</div>
                        <div class="jm-account-meta">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <circle cx="12" cy="12" r="10"/>
                                <polyline points="12 6 12 12 16 14"/>
                            </svg>
                            <span>${expiresText}</span>
                            <span class="jm-account-tag ${acc.type || 'cloud'}">${acc.type === 'local' ? '本地' : '云端'}</span>
                        </div>
                    </div>
                    <div class="jm-account-actions">
                        <button
                            class="jm-btn ${isActive ? 'jm-btn-active' : 'jm-btn-secondary'}"
                            onclick="parent.JimengApp.onAccountSelect('${this._escapeHtml(acc.id)}')"
                        >
                            ${isActive ? '使用中' : '使用'}
                        </button>
                        <button
                            class="jm-btn jm-btn-danger"
                            onclick="parent.JimengApp.onAccountDelete('${this._escapeHtml(acc.id)}')"
                        >
                            删除
                        </button>
                    </div>
                </div>
            `;
        }).join('');
    },

    /**
     * 同步授权按钮状态
     */
    _syncAuthButtons() {
        const cloudBtn = document.getElementById('jm-btn-cloud-auth');
        const localBtn = document.getElementById('jm-btn-local-auth');
        const isLoading = JimengState.isAuthorizing();

        if (cloudBtn) {
            cloudBtn.disabled = isLoading;
            if (isLoading && JimengState.getAuthorizingType() === 'cloud') {
                cloudBtn.innerHTML = `
                    <svg class="jm-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                    </svg>
                    授权中...
                `;
            } else {
                cloudBtn.innerHTML = `
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>
                    </svg>
                    授权
                `;
            }
        }

        if (localBtn) {
            localBtn.disabled = isLoading;
            if (isLoading && JimengState.getAuthorizingType() === 'local') {
                localBtn.innerHTML = `
                    <svg class="jm-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                    </svg>
                    授权中...
                `;
            } else {
                localBtn.innerHTML = `
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>
                    </svg>
                    授权
                `;
            }
        }
    },

    // ============================================================
    // 事件处理
    // ============================================================

    /**
     * 表单字段变更（实时同步到状态）
     */
    onFieldChange(key, value) {
        JimengState.setFormField(key, value);
    },

    /**
     * 授权操作
     */
    authorize(type) {
        if (type === 'cloud') {
            this._authorizeCloud();
        } else {
            this._authorizeLocal();
        }
    },

    async _authorizeCloud() {
        const token = JimengState.getForm().cloud_token;
        if (!token || !token.trim()) {
            this.logWarning('请先输入云端 Authorization Token');
            this._showToast('请先输入云端 Authorization Token', 'warning');
            return;
        }

        this.log('开始云端授权...');
        JimengState.setAuthorizing('cloud');
        this._renderAll();

        try {
            const result = await JimengApi.authorizeCloud(token.trim());
            if (result.success || result.account) {
                const account = result.account || result;
                JimengState.addAccount(account);
                JimengState.setActiveAccountId(account.id);
                JimengState.clearForm();

                const inputEl = document.getElementById('jm-input-cloud-token');
                if (inputEl) inputEl.value = '';

                this.logSuccess('云端授权成功！账号：' + (account.name || account.id));
                this._showToast('云端授权成功！', 'success');
            } else {
                this.logError('云端授权失败：' + (result.message || '未知错误'));
                this._showToast(result.message || '云端授权失败，请检查 Token', 'error');
            }
        } catch (e) {
            this.logError('云端授权异常：' + (e.message || '网络错误'));
            this._showToast(e.message || '云端授权失败，请检查 Token 和网络连接', 'error');
        } finally {
            JimengState.clearAuthorizing();
            this._renderAll();
        }
    },

    async _authorizeLocal() {
        const fileInput = document.getElementById('jm-input-local-file');
        const file = fileInput && fileInput.files && fileInput.files[0];

        if (!file) {
            this.logWarning('请先选择 .sxc 文件');
            this._showToast('请先选择 .sxc 文件', 'warning');
            return;
        }

        if (!file.name.toLowerCase().endsWith('.sxc')) {
            this.logError('仅支持 .sxc 格式文件');
            this._showToast('仅支持 .sxc 格式文件', 'error');
            return;
        }

        this.log('正在读取文件：' + file.name);

        try {
            const content = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = e => resolve(e.target.result);
                reader.onerror = () => reject(new Error('文件读取失败'));
                reader.readAsText(file);
            });

            this.log('开始本地导入...');
            JimengState.setAuthorizing('local');
            this._renderAll();

            const result = await JimengApi.authorizeLocal(content, file.name);

            if (result.success || result.account) {
                const account = result.account || result;
                JimengState.addAccount(account);
                JimengState.setActiveAccountId(account.id);

                fileInput.value = '';
                this.logSuccess('本地导入成功！账号：' + (account.name || account.id));
                this._showToast('本地导入成功！', 'success');
            } else {
                this.logError('本地导入失败：' + (result.message || '未知错误'));
                this._showToast(result.message || '本地导入失败', 'error');
            }
        } catch (e) {
            this.logError('本地导入异常：' + e.message);
            this._showToast(e.message || '本地导入失败', 'error');
        } finally {
            JimengState.clearAuthorizing();
            this._renderAll();
        }
    },

    /**
     * 选中/激活账号
     */
    async onAccountSelect(accountId) {
        const prevActive = JimengState.getActiveAccountId();
        if (accountId === prevActive) return;

        this.log('正在切换账号...');
        try {
            await JimengApi.setActiveAccount(accountId);
            JimengState.setActiveAccountId(accountId);
            const account = JimengState.getAccountById(accountId);
            this.logSuccess('账号已切换为：' + (account?.name || accountId));
            this._showToast('账号已切换', 'success');
        } catch (e) {
            this.logError('切换账号失败：' + e.message);
            this._showToast('切换账号失败: ' + e.message, 'error');
        }

        this._renderAll();
    },

    /**
     * 删除账号
     */
    async onAccountDelete(accountId) {
        const account = JimengState.getAccountById(accountId);
        if (!account) return;

        const confirmed = window.confirm('确定要删除账号「' + (account.name || accountId) + '」吗？');
        if (!confirmed) return;

        this.log('正在删除账号：' + (account?.name || accountId));
        try {
            await JimengApi.deleteAccount(accountId);
            JimengState.removeAccount(accountId);
            this.logSuccess('账号已删除：' + (account?.name || accountId));
            this._showToast('账号已删除', 'success');
        } catch (e) {
            this.logError('删除账号失败：' + e.message);
            this._showToast('删除账号失败: ' + e.message, 'error');
        }

        this._renderAll();
    },

    // ============================================================
    // 导航切换
    // ============================================================
    _bindNavigation() {
        document.querySelectorAll('.jm-nav-item').forEach(item => {
            item.addEventListener('click', () => {
                const nav = item.dataset.nav;

                document.querySelectorAll('.jm-nav-item').forEach(i => i.classList.remove('active'));
                item.classList.add('active');

                if (nav === 'accounts') {
                    // 当前即梦标签页的主视图就是账号管理，无需切换
                } else if (nav === 'settings') {
                    this._showToast('设置功能开发中...', 'warning');
                }
            });
        });
    },

    // ============================================================
    // 辅助工具
    // ============================================================

    /**
     * 格式化有效期显示
     */
    _formatExpires(timestamp) {
        if (!timestamp) return '永久';
        const date = new Date(timestamp * 1000);
        const now = new Date();
        const diff = date - now;

        if (diff < 0) return '已过期';

        const days = Math.floor(diff / (1000 * 60 * 60 * 24));
        if (days < 1) return '今日过期';
        if (days < 7) return '剩余 ' + days + ' 天';
        if (days < 30) return '剩余 ' + Math.floor(days / 7) + ' 周';
        return date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }) + ' 到期';
    },

    /**
     * HTML 特殊字符转义（防止 XSS）
     */
    _escapeHtml(str) {
        if (str === null || str === undefined) return '';
        const div = document.createElement('div');
        div.textContent = String(str);
        return div.innerHTML;
    },

    /**
     * 显示 Toast 提示（复用主框架的 Toast 机制）
     */
    _showToast(message, type = 'info') {
        if (window.showToast) {
            window.showToast(message);
        } else if (window.EventBus) {
            window.EventBus.emit('toast', { message, type });
        }

        if (window.parent && window.parent !== window) {
            window.parent.postMessage({ type: 'jm:toast', message }, '*');
        }
    },

    // ============================================================
    // 控制台日志
    // ============================================================
    _log(message, type = 'info') {
        const bodyEl = document.getElementById('jm-console-body');
        const emptyEl = document.getElementById('jm-console-empty');
        if (!bodyEl) return;

        if (emptyEl) emptyEl.style.display = 'none';

        const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const line = { time, message, type };
        this._consoleLines.push(line);

        const lineEl = document.createElement('div');
        lineEl.className = 'jm-console-line ' + type;
        lineEl.innerHTML = '<span class="jm-console-time">[' + time + ']</span>' + this._escapeHtml(message);
        bodyEl.appendChild(lineEl);
        bodyEl.scrollTop = bodyEl.scrollHeight;
    },

    log(message)    { this._log(message, 'info'); },
    logSuccess(message) { this._log(message, 'success'); },
    logWarning(message) { this._log(message, 'warning'); },
    logError(message)   { this._log(message, 'error'); },

    _bindConsoleClear() {
        const btn = document.getElementById('jm-btn-clear-console');
        if (btn) btn.addEventListener('click', () => {
            this._consoleLines = [];
            const bodyEl = document.getElementById('jm-console-body');
            const emptyEl = document.getElementById('jm-console-empty');
            if (bodyEl) bodyEl.innerHTML = '';
            if (emptyEl) emptyEl.style.display = '';
        });
    },

    _bindFileInput() {
        const fileInput = document.getElementById('jm-input-local-file');
        const fileText = document.getElementById('jm-file-text');
        if (!fileInput || !fileText) return;
        fileInput.addEventListener('change', () => {
            if (fileInput.files && fileInput.files[0]) {
                fileText.textContent = fileInput.files[0].name;
            } else {
                fileText.textContent = '选择文件';
            }
        });
    },

    // ============================================================
    // 销毁
    // ============================================================
    destroy() {
        JimengState.destroy();
        this._initialized = false;
    },
};

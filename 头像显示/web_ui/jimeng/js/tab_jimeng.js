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

        // 监听刷新列表的事件
        window.electronAPI.on('jimeng:refreshList', () => {
            this._loadAndRender();
        });
    },

    // ============================================================
    // 数据加载
    // ============================================================
    async _loadAndRender() {
        try {
            this.log('正在加载账号数据...');
            const accounts = await JimengApi.getAccounts().catch(() => []);

            JimengState.setAccounts(accounts);
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
     * 渲染账号列表（显示头像 + 真实昵称）
     */
    _renderAccountList() {
        const listEl = document.getElementById('jm-account-list');
        const emptyEl = document.getElementById('jm-empty-state');
        if (!listEl) return;

        const accounts = JimengState.getAccounts();

        if (accounts.length === 0) {
            if (emptyEl) emptyEl.style.display = '';
            return;
        }

        if (emptyEl) emptyEl.style.display = 'none';

        listEl.innerHTML = accounts.map(acc => {
            const importTime = acc.createdAt
                ? new Date(acc.createdAt).toLocaleString('zh-CN')
                : '未知';
            const displayName = acc.nickname || acc.name || acc.id;

            return `
                <div class="jm-account-item" data-account-id="${this._escapeHtml(acc.id)}">
                    <div class="jm-account-avatar">
                        ${acc.avatarPath
                            ? `<img src="app-media://local/${acc.avatarPath.replace(/\\/g, '/')}" alt="头像" />`
                            : `<div class="jm-default-avatar">${displayName.charAt(0)}</div>`
                        }
                    </div>
                    <div class="jm-account-info">
                        <div class="jm-account-name">${this._escapeHtml(displayName)}</div>
                        <div class="jm-account-meta">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <circle cx="12" cy="12" r="10"/>
                                <polyline points="12 6 12 12 16 14"/>
                            </svg>
                            <span>导入于 ${importTime}</span>
                        </div>
                    </div>
                    <div class="jm-account-actions">
                        <button
                            class="jm-btn jm-btn-primary"
                            onclick="parent.JimengApp.onAccountLaunch('${this._escapeHtml(acc.id)}')"
                        >
                            启动浏览器
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

        this.logWarning('云端 Token 授权暂不支持，请使用 .sxc 文件导入');
        this._showToast('云端 Token 授权暂不支持，请使用 .sxc 文件导入', 'warning');
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

        this.log('正在导入：' + file.name);
        JimengState.setAuthorizing('local');
        this._syncAuthButtons();

        try {
            const result = await JimengApi.importSxcFile(file);

            if (result.success || result.account) {
                const account = result.account || result;
                JimengState.addAccount(account);
                fileInput.value = '';
                const fileText = document.getElementById('jm-file-text');
                if (fileText) fileText.textContent = '选择文件';
                this.logSuccess('导入成功！账号：' + (account.name || account.id));
                this._showToast('导入成功！', 'success');
            } else {
                throw new Error(result.message || result.error || '未知错误');
            }
        } catch (e) {
            this.logError('导入失败：' + e.message);
            this._showToast(e.message || '导入失败', 'error');
        } finally {
            JimengState.clearAuthorizing();
            this._renderAll();
        }
    },

    /**
     * 启动账号的安全浏览器窗口
     */
    async onAccountLaunch(accountId) {
        const account = JimengState.getAccountById(accountId);
        this.log('正在启动账号：' + (account?.nickname || account?.name || accountId));

        try {
            const result = await JimengApi.launchAccount(accountId);
            if (result.success) {
                this.logSuccess('安全浏览器已启动！');
                this._showToast('安全浏览器已启动！', 'success');
                // 启动后刷新列表，以更新头像
                await this._loadAndRender();
            } else {
                throw new Error(result.error || '启动失败');
            }
        } catch (e) {
            this.logError('启动失败：' + e.message);
            this._showToast(e.message || '启动失败', 'error');
        }
    },

    /**
     * 删除账号
     */
    async onAccountDelete(accountId) {
        const account = JimengState.getAccountById(accountId);
        if (!account) return;

        const confirmed = window.confirm('确定要删除账号「' + (account.nickname || account.name || accountId) + '」吗？');
        if (!confirmed) return;

        this.log('正在删除账号：' + (account?.nickname || account?.name || accountId));
        try {
            await JimengApi.deleteAccount(accountId);
            JimengState.removeAccount(accountId);
            this.logSuccess('账号已删除：' + (account?.nickname || account?.name || accountId));
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

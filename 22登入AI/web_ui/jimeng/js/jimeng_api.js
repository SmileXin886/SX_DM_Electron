/**
 * 即梦AI标签页 - API 调用层
 * 所有与后端通信的 HTTP 请求经由此模块
 */
const JimengApi = {
    /**
     * 获取即梦AI账号列表
     */
    async getAccounts() {
        try {
            const res = await fetch('/api/jimeng/accounts', {
                method: 'GET',
                headers: { 'Content-Type': 'application/json' },
            });
            if (!res.ok) throw new Error('获取账号列表失败: ' + res.status);
            const data = await res.json();
            return data.accounts || [];
        } catch (e) {
            console.error('[JimengApi] 获取账号列表失败:', e);
            throw e;
        }
    },

    /**
     * 添加/授权账号（云端 Token 模式）
     * @param {string} token - Authorization Token
     */
    async authorizeCloud(token) {
        try {
            const res = await fetch('/api/jimeng/accounts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'cloud', token }),
            });
            if (!res.ok) {
                const err = await res.text();
                throw new Error(err || '授权失败: ' + res.status);
            }
            return await res.json();
        } catch (e) {
            console.error('[JimengApi] 云端授权失败:', e);
            throw e;
        }
    },

    /**
     * 添加/授权账号（本地 SXC 文件模式）
     * @param {string} content - .sxc 文件文本内容
     * @param {string} fileName - 文件名
     */
    async authorizeLocal(content, fileName) {
        try {
            const res = await fetch('/api/jimeng/accounts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'local', content, fileName }),
            });
            if (!res.ok) {
                const err = await res.text();
                throw new Error(err || '导入失败: ' + res.status);
            }
            return await res.json();
        } catch (e) {
            console.error('[JimengApi] 本地导入失败:', e);
            throw e;
        }
    },

    /**
     * 删除账号
     * @param {string} accountId
     */
    async deleteAccount(accountId) {
        try {
            const res = await fetch('/api/jimeng/accounts/' + encodeURIComponent(accountId), {
                method: 'DELETE',
            });
            if (!res.ok) throw new Error('删除账号失败: ' + res.status);
            return await res.json();
        } catch (e) {
            console.error('[JimengApi] 删除账号失败:', e);
            throw e;
        }
    },

    /**
     * 切换当前激活账号
     * @param {string} accountId
     */
    async setActiveAccount(accountId) {
        try {
            const res = await fetch('/api/jimeng/accounts/' + encodeURIComponent(accountId) + '/activate', {
                method: 'POST',
            });
            if (!res.ok) throw new Error('切换账号失败: ' + res.status);
            return await res.json();
        } catch (e) {
            console.error('[JimengApi] 切换账号失败:', e);
            throw e;
        }
    },

    /**
     * 获取当前激活账号 ID（从后端）
     */
    async getActiveAccountId() {
        try {
            const res = await fetch('/api/jimeng/accounts/active', {
                method: 'GET',
            });
            if (!res.ok) return null;
            const data = await res.json();
            return data.active_id || null;
        } catch {
            return null;
        }
    },
};

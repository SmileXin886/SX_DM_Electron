/**
 * 即梦AI标签页 - API 调用层
 * 所有与后端通信的 HTTP 请求经由此模块
 *
 * 【API 对照表】
 * GET  /api/jimeng/accounts       → 获取账号列表
 * POST /api/jimeng/import        → 导入 .sxc 文件（二进制 multipart）
 * POST /api/jimeng/launch        → 启动账号的安全浏览器窗口
 * DELETE /api/jimeng/accounts/{id} → 删除账号
 *
 * 【协议说明】Electron 使用 loadFile() 加载 index.html，前端以 file:// 运行
 * 绝对路径 fetch('/api/...') 会被解析为 file:///api/...，永远无法连接 FastAPI
 * 因此必须使用 httpClient（已在 api.js 中配置绝对 URL http://127.0.0.1:8765）
 */
const JimengApi = {
    /**
     * 获取即梦AI账号列表
     */
    async getAccounts() {
        try {
            const data = await window.httpClient.get('/api/jimeng/accounts');
            return data.accounts || [];
        } catch (e) {
            console.error('[JimengApi] 获取账号列表失败:', e);
            throw e;
        }
    },

    /**
     * 导入 .sxc 文件（二进制 multipart 方式）
     * 使用原生 fetch + 绝对 URL，因为 httpClient 是 JSON-only
     * @param {File} file - .sxc 文件对象
     */
    async importSxcFile(file) {
        try {
            const formData = new FormData();
            formData.append('file', file);

            const res = await fetch('http://127.0.0.1:8765/api/jimeng/import', {
                method: 'POST',
                body: formData,
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({ error: '导入失败' }));
                throw new Error(err.error || '导入失败: ' + res.status);
            }
            return await res.json();
        } catch (e) {
            console.error('[JimengApi] 导入 .sxc 失败:', e);
            throw e;
        }
    },

    /**
     * 启动账号的安全浏览器窗口
     */
    async launchAccount(accountId) {
        try {
            const data = await window.httpClient.post('/api/jimeng/launch', { account_id: accountId });
            return data;
        } catch (e) {
            console.error('[JimengApi] 启动浏览器失败:', e);
            throw e;
        }
    },

    /**
     * 删除账号
     */
    async deleteAccount(accountId) {
        try {
            return await window.httpClient.delete('/api/jimeng/accounts/' + encodeURIComponent(accountId));
        } catch (e) {
            console.error('[JimengApi] 删除账号失败:', e);
            throw e;
        }
    },
};

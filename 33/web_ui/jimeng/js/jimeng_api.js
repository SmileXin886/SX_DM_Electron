/**
 * 即梦AI标签页 - API 调用层
 * 所有与后端通信统一通过 Electron IPC (window.electronAPI)
 *
 * 【协议说明】Electron 使用 loadFile() 加载 index.html，前端以 file:// 运行
 * 相对路径 fetch('/api/...') 会被解析为 file:///api/...，永远无法连接 FastAPI
 * 因此所有请求必须走 window.electronAPI.invoke()，由 Electron 主进程处理
 */
const JimengApi = {
    /**
     * 获取即梦AI账号列表
     */
    async getAccounts() {
        try {
            const res = await window.electronAPI.listJimengAccounts();
            if (!res.success) throw new Error(res.error || '获取账号列表失败');
            return res.accounts || [];
        } catch (e) {
            console.error('[JimengApi] 获取账号列表失败:', e);
            throw e;
        }
    },

    /**
     * 导入 .sxc 文件（解密后加密存储）
     * @param {File} file - .sxc 文件对象
     */
    async importSxcFile(file) {
        try {
            const buffer = await file.arrayBuffer();
            // electronAPI.invoke 接收普通数组（TypedArray），主进程转 Buffer
            const res = await window.electronAPI.importJimengAccount(
                Array.from(new Uint8Array(buffer)),
                file.name
            );
            if (!res.success) throw new Error(res.error || '导入失败');
            return res;
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
            const res = await window.electronAPI.launchJimengAccount(accountId);
            if (!res.success) throw new Error(res.error || '启动失败');
            return res;
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
            const res = await window.electronAPI.deleteJimengAccount(accountId);
            return res;
        } catch (e) {
            console.error('[JimengApi] 删除账号失败:', e);
            throw e;
        }
    },

    /**
     * 重新排序账号（持久化到后端）
     * @param {string[]} orderedIds - 账号 ID 数组（新顺序）
     */
    async reorderAccounts(orderedIds) {
        try {
            const res = await window.electronAPI.reorderJimengAccounts(orderedIds);
            if (!res.success) throw new Error(res.error || '排序保存失败');
            return res;
        } catch (e) {
            console.error('[JimengApi] 保存排序失败:', e);
            throw e;
        }
    },
};

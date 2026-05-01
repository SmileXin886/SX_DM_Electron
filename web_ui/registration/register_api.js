/**
 * 注册模块 API 调用层
 * 所有注册相关的 HTTP/WebSocket 请求经由此模块
 */
const RegisterApi = {
    /**
     * 获取配置数据
     */
    async getConfig() {
        try {
            const res = await fetch('/api/config');
            if (!res.ok) throw new Error('获取配置失败');
            return await res.json();
        } catch {
            return {};
        }
    },

    /**
     * 获取支持的平台列表
     */
    async getPlatforms() {
        try {
            const res = await fetch('/api/platforms');
            if (!res.ok) throw new Error('获取平台列表失败');
            return await res.json();
        } catch {
            return [];
        }
    },

    /**
     * 获取配置选项（provider 列表等）
     */
    async getConfigOptions() {
        try {
            const res = await fetch('/api/config/options');
            if (!res.ok) throw new Error('获取配置选项失败');
            return await res.json();
        } catch {
            return null;
        }
    },

    /**
     * 提交注册任务
     */
    async submitTask(payload) {
        const res = await fetch('/api/tasks/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (!res.ok) {
            const err = await res.text();
            throw new Error(err || '提交任务失败');
        }
        return await res.json();
    },

    /**
     * 查询任务详情
     */
    async getTask(taskId) {
        const res = await fetch(`/api/tasks/${taskId}`);
        if (!res.ok) throw new Error('查询任务失败');
        return await res.json();
    },

    /**
     * 查询任务实时日志事件
     */
    async getTaskEvents(taskId, since = 0, limit = 200) {
        const res = await fetch(`/api/tasks/${taskId}/events?since=${since}&limit=${limit}`);
        if (!res.ok) throw new Error('获取任务日志失败');
        return await res.json();
    },

    /**
     * 取消任务
     */
    async cancelTask(taskId) {
        const res = await fetch(`/api/tasks/${taskId}/cancel`, {
            method: 'POST',
        });
        if (!res.ok) throw new Error('取消任务失败');
        return await res.json();
    },
};

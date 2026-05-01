/**
 * 执行状态面板
 * 显示任务状态、进度、成功/失败统计
 */
const RegCardStatus = {

    render(task) {
        const body = document.getElementById('reg-task-body');
        if (!body) return;

        if (!task) {
            body.innerHTML = `
                <div style="text-align:center;padding:24px 16px;">
                    <div style="font-size:32px;margin-bottom:8px;opacity:0.3;">${RegUtils.icon('workflow')}</div>
                    <div style="font-size:13px;color:#6e7681;">提交任务后将显示执行状态和日志</div>
                </div>`;
            return;
        }

        const stats = buildTaskStats(task);
        const statusMap = {
            pending: 'pending', started: 'running', running: 'running',
            succeeded: 'succeeded', failed: 'failed', cancelled: 'failed', interrupted: 'failed',
        };
        const labelMap = {
            pending: '等待中', started: '进行中', running: '进行中',
            succeeded: '成功', failed: '失败', cancelled: '已取消', interrupted: '已中断',
        };
        const variant = statusMap[task.status] || 'pending';
        const label = labelMap[task.status] || task.status || '-';
        const iconName = variant === 'succeeded' ? 'check' : variant === 'failed' ? 'x' : 'loader';

        body.innerHTML = `
            <div style="margin-bottom:12px;">
                <span class="reg-status-badge ${variant}">
                    ${RegUtils.icon(iconName)} ${RegUtils.esc(label)}
                </span>
            </div>
            <div class="reg-stat-grid">
                ${stats.map(s => {
                    const iconMap = { check: 'check', x: 'x', orbit: 'orbit', workflow: 'workflow', progress: 'workflow' };
                    return `
                        <div class="reg-stat-cell">
                            <div class="reg-stat-label">${RegUtils.icon(iconMap[s.icon] || 'workflow')} ${RegUtils.esc(s.label)}</div>
                            <div class="reg-stat-value">${RegUtils.esc(String(s.value))}</div>
                        </div>`;
                }).join('')}
            </div>
            ${task.id ? `<div class="reg-task-id">任务ID: ${RegUtils.esc(task.id)}</div>` : ''}
            ${(task.errors?.length > 0 || task.error) ? `
                <div style="margin-top:10px;">
                    ${(task.errors || []).concat(task.error ? [task.error] : []).map(e =>
                        `<div style="display:flex;align-items:flex-start;gap:6px;font-size:11px;color:#f85149;margin-bottom:4px;">
                            ${RegUtils.icon('x')} ${RegUtils.esc(e)}
                        </div>`
                    ).join('')}
                </div>` : ''}`;
    },
};

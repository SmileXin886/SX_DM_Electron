/**
 * 实时日志面板
 */
const RegCardLog = {

    render(logLines) {
        const el = document.getElementById('reg-log-panel');
        if (!el) return;

        if (logLines.length === 0) {
            el.innerHTML = `<div class="reg-log-line reg-log-info">等待任务开始...</div>`;
            return;
        }

        el.innerHTML = logLines.map(l =>
            `<div class="reg-log-line reg-log-${l.level}">
                <span style="color:#4a4a4a;">[${l.timestamp}]</span> ${RegUtils.esc(l.message)}
            </div>`
        ).join('');
        el.scrollTop = el.scrollHeight;
    },
};

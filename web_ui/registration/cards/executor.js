/**
 * 执行通道卡片
 * 协议模式 / 无头浏览器 / 有头浏览器
 */
const RegCardExecutor = {

    render(form, options) {
        const el = document.getElementById('reg-executor-options');
        if (!el) return;

        el.innerHTML = options.map(opt => {
            const active = form.executor_type === opt.value;
            const icon = opt.value === 'protocol' ? 'protocol' : 'browser';
            return `
                <div class="reg-pill ${active ? 'active' : ''} ${opt.disabled ? 'disabled' : ''}"
                    onclick="${opt.disabled ? '' : `RegisterApp.onExecutorSelect('${RegUtils.esc(opt.value)}')`}">
                    <div class="reg-pill-icon">${RegUtils.icon(icon)}</div>
                    <span class="reg-pill-label">${RegUtils.esc(opt.label)}</span>
                    <div class="reg-pill-desc">${RegUtils.esc(opt.description)}</div>
                    ${opt.reason ? `<div class="reg-pill-desc" style="color:#f0b429;">${RegUtils.esc(opt.reason)}</div>` : ''}
                </div>`;
        }).join('');
    },
};

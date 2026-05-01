/**
 * 右侧摘要面板
 * 当前配置摘要 + 开始注册按钮
 */
const RegCardSummary = {

    render(form, currentPlatform, regLabel, execLabel, captchaLabel) {
        const el = document.getElementById('reg-summary-chips');
        if (!el) return;
        el.innerHTML = `
            <div class="reg-summary-chip">
                <div class="reg-summary-chip-label">${RegUtils.icon('platform')} 平台</div>
                <div class="reg-summary-chip-value">${RegUtils.esc(currentPlatform?.display_name || form.platform || '-')}</div>
            </div>
            <div class="reg-summary-chip">
                <div class="reg-summary-chip-label">${RegUtils.icon('identity')} 账号来源</div>
                <div class="reg-summary-chip-value">${RegUtils.esc(regLabel)}</div>
            </div>
            <div class="reg-summary-chip">
                <div class="reg-summary-chip-label">${RegUtils.icon('workflow')} 执行通道</div>
                <div class="reg-summary-chip-value">${RegUtils.esc(execLabel)}</div>
            </div>
            <div class="reg-summary-chip">
                <div class="reg-summary-chip-label">${RegUtils.icon('shield')} 验证码</div>
                <div class="reg-summary-chip-value">${RegUtils.esc(captchaLabel)}</div>
            </div>`;
    },

    setButtonLoading(loading) {
        const btn = document.getElementById('reg-submit-btn');
        if (!btn) return;
        btn.disabled = loading;
        if (loading) {
            btn.innerHTML = `${RegUtils.icon('loader')} 提交中...`;
        } else {
            btn.innerHTML = `${RegUtils.icon('play')} 开始注册`;
        }
    },
};

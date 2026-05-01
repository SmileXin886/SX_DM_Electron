/**
 * 基础配置卡片
 * 平台选择、数量输入、代理输入
 */
const RegCardBasic = {

    render(form, platformOptions) {
        const platformEl = document.getElementById('reg-platform');
        const countEl = document.getElementById('reg-count');
        const proxyEl = document.getElementById('reg-proxy');

        if (platformEl) {
            platformEl.innerHTML =
                `<option value="">-- 选择平台 --</option>` +
                platformOptions.map(o =>
                    `<option value="${RegUtils.esc(o.value)}" ${form.platform === o.value ? 'selected' : ''}>${RegUtils.esc(o.label)}</option>`
                ).join('');
        }

        if (countEl && countEl.value !== String(form.count || 1)) {
            countEl.value = form.count || 1;
        }

        if (proxyEl && proxyEl.value !== (form.proxy || '')) {
            proxyEl.value = form.proxy || '';
        }
    },
};

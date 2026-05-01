/**
 * 账号来源卡片
 * 邮箱注册 / OAuth 登录 选项
 */
const RegCardIdentity = {

    render(form, options) {
        const el = document.getElementById('reg-identity-options');
        if (!el) return;

        if (options.length === 0) {
            el.innerHTML = `<div style="font-size:12px;color:#6e7681;padding:8px;">当前平台无可用的注册方式</div>`;
            return;
        }

        el.innerHTML = options.map(opt => {
            const active = form.identity_provider === opt.identityProvider &&
                           form.oauth_provider === opt.oauthProvider;
            const icon = opt.icon === 'mail' ? 'mail' : 'shield';
            return `
                <div class="reg-pill ${active ? 'active' : ''}"
                     onclick="RegisterApp.onIdentitySelect('${RegUtils.esc(opt.identityProvider)}','${RegUtils.esc(opt.oauthProvider)}')">
                    <div class="reg-pill-icon">${RegUtils.icon(icon)}</div>
                    <span class="reg-pill-label">${RegUtils.esc(opt.label)}</span>
                    <div class="reg-pill-desc">${RegUtils.esc(opt.description)}</div>
                </div>`;
        }).join('');
    },
};

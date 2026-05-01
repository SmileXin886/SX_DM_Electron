/**
 * 邮件 / 短信 Provider 配置卡片
 * 依赖 register_config.js 的 getProviderMergedValues / getProviderSetting
 */
const RegCardProvider = {

    renderMail(form, configOptions) {
        const card = document.getElementById('reg-card-mail-provider');
        const errorEl = document.getElementById('reg-mail-provider-error');
        const selectEl = document.getElementById('reg-mail-provider-select');
        if (!card) return;

        if (form.identity_provider !== 'mailbox') {
            card.classList.add('reg-hidden');
            return;
        }
        card.classList.remove('reg-hidden');

        const providers = configOptions.mailbox_providers || [];
        const error = RegisterState.getOptionsError();

        if (errorEl) {
            errorEl.innerHTML = error
                ? `<div class="reg-alert error" style="margin-bottom:12px;">${RegUtils.icon('warning')} ${RegUtils.esc(error)}</div>`
                : '';
        }

        if (!selectEl) return;
        if (providers.length > 0) {
            const current = providers.find(p => p.value === form.mail_provider);
            selectEl.innerHTML = `
                <div class="reg-field">
                    <label class="reg-label">邮件服务</label>
                    <select class="reg-select" id="reg-mail-provider"
                        onchange="RegisterApp.onFieldChange('mail_provider', this.value)">
                        ${providers.map(p =>
                            `<option value="${RegUtils.esc(p.value)}" ${form.mail_provider === p.value ? 'selected' : ''}>${RegUtils.esc(p.label || p.value)}</option>`
                        ).join('')}
                    </select>
                </div>
                ${current?.description ? `<p style="font-size:11px;color:#6e7681;margin-top:6px;">${RegUtils.esc(current.description)}</p>` : ''}`;
        } else {
            selectEl.innerHTML = `<div class="reg-alert warning">${RegUtils.icon('warning')} 当前没有已配置的邮件 provider，请先到设置页面添加</div>`;
        }
    },

    renderSms(form, configOptions) {
        const card = document.getElementById('reg-card-sms-provider');
        const selectEl = document.getElementById('reg-sms-provider-select');
        if (!card) return;

        const providers = configOptions.sms_providers || [];
        if (providers.length === 0) {
            card.classList.add('reg-hidden');
            return;
        }
        card.classList.remove('reg-hidden');

        if (!selectEl) return;
        selectEl.innerHTML = `
            <div class="reg-field">
                <label class="reg-label">短信服务</label>
                <select class="reg-select" id="reg-sms-provider"
                    onchange="RegisterApp.onFieldChange('sms_provider', this.value)">
                    ${providers.map(p =>
                        `<option value="${RegUtils.esc(p.value)}" ${form.sms_provider === p.value ? 'selected' : ''}>${RegUtils.esc(p.label || p.value)}</option>`
                    ).join('')}
                </select>
            </div>`;
    },
};

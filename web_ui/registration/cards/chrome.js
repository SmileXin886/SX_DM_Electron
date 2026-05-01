/**
 * Chrome Profile 配置卡片
 * 仅在 OAuth 模式下显示
 */
const RegCardChrome = {

    render(form) {
        const card = document.getElementById('reg-card-chrome-profile');
        if (!card) return;

        const show = form.identity_provider === 'oauth_browser';
        if (show) card.classList.remove('reg-hidden');
        else { card.classList.add('reg-hidden'); return; }

        const setVal = (id, val) => {
            const el = document.getElementById(id);
            if (el && el.value !== val) el.value = val;
        };
        setVal('reg-oauth-email-hint', form.oauth_email_hint || '');
        setVal('reg-chrome-user-data-dir', form.chrome_user_data_dir || '');
        setVal('reg-chrome-cdp-url', form.chrome_cdp_url || '');
    },
};

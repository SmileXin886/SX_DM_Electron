/**
 * æ³¨å†Œæ¨¡å¼ Tab ä¸»å…¥å£
 * æ¯ä¸ªå¡ç‰‡æ¸²æŸ“é€»è¾‘æ‹†åˆ†åˆ° cards/ ç›®å½•ä¸‹ç‹¬ç«‹æ–‡ä»¶
 */
window.RegisterApp = {

    _initialized: false,

    init() {
        if (this._initialized) return;
        this._initialized = true;
        RegisterState.init();
        this._renderAll();
        this._loadAndRender();
    },

    // ============================================================
    // æ•°æ®åŠ è½½ï¼ˆåŽå°é™é»˜ï¼Œä¸é˜»å¡ž UIï¼‰
    // ============================================================

    async _loadAndRender() {
        try {
            const [cfg, platforms, options] = await Promise.all([
                RegisterApi.getConfig().catch(() => ({})),
                RegisterApi.getPlatforms().catch(() => []),
                RegisterApi.getConfigOptions().catch(() => null),
            ]);

            RegisterState.setPlatforms(platforms || []);
            RegisterState.setConfigOptions(options);
            RegisterState.setOptionsError(
                options ? '' : 'æ— æ³•åŠ è½½ provider å…ƒæ•°æ®ï¼Œè¯·å…ˆé…ç½®ç›¸å…³ provider',
            );

            const form = RegisterState.getForm();
            RegisterState.setForm({
                ...form,
                executor_type: cfg.default_executor || 'protocol',
                captcha_solver: 'auto',
                identity_provider: cfg.default_identity_provider || 'mailbox',
                oauth_provider: cfg.default_oauth_provider || 'google',
                oauth_email_hint: cfg.oauth_email_hint || '',
                chrome_user_data_dir: cfg.chrome_user_data_dir || '',
                chrome_cdp_url: cfg.chrome_cdp_url || '',
                mail_provider: _getDefaultProviderKey(options?.mailbox_settings || []) || '',
                sms_provider: _getDefaultProviderKey(options?.sms_settings || []) || '',
            });

            const ps = RegisterState.getPlatforms();
            if (!RegisterState.get('platform') && ps.length > 0) {
                RegisterState.set('platform', ps[0].name || '');
            }

            this._renderAll();

        } catch (e) {
            console.error('[Register] åŠ è½½å¤±è´¥:', e);
            this._renderAll();
        }
    },

    // ============================================================
    // å…¨é‡æ¸²æŸ“
    // ============================================================

    _renderAll() {
        const form = RegisterState.getForm();
        const platforms = RegisterState.getPlatforms();
        const configOptions = RegisterState.getConfigOptions() || {};
        const currentPlatform = RegisterState.getCurrentPlatform();

        const platformOptions = RegisterState.getPlatformOptions();
        const registrationOptions = buildRegistrationOptions(currentPlatform);
        const supportedExecutors = currentPlatform?.supported_executors || [];
        const executorOptions = buildExecutorOptions(
            form.identity_provider,
            supportedExecutors,
            _hasReusableOAuthBrowser(form),
            currentPlatform?.supported_executor_options || [],
        );

        const summaryRegistration = registrationOptions.find(o =>
            o.identityProvider === form.identity_provider && o.oauthProvider === form.oauth_provider,
        )?.label || '-';

        const summaryExecutor = executorOptions.find(o => o.value === form.executor_type)?.label || '-';
        const summaryVerification = getCaptchaStrategyLabel(
            form.executor_type,
            configOptions.captcha_policy,
            configOptions.captcha_providers,
        );

        // å„å¡ç‰‡ç‹¬ç«‹æ¸²æŸ“
        RegCardBasic.render(form, platformOptions);
        RegCardIdentity.render(form, registrationOptions);
        RegCardExecutor.render(form, executorOptions);
        RegCardChrome.render(form);
        RegCardProvider.renderMail(form, configOptions);
        RegCardProvider.renderSms(form, configOptions);
        RegCardSummary.render(form, currentPlatform, summaryRegistration, summaryExecutor, summaryVerification);
        RegCardStatus.render(RegisterState.getTask());
        RegCardLog.render(RegisterState.getLogLines());
    },

    // ============================================================
    // äº‹ä»¶å¤„ç†
    // ============================================================

    onPlatformChange(value) {
        RegisterState.set('platform', value);
        const platform = RegisterState.getCurrentPlatform();
        const opts = buildRegistrationOptions(platform);
        if (opts.length > 0) {
            RegisterState.set('identity_provider', opts[0].identityProvider);
            RegisterState.set('oauth_provider', opts[0].oauthProvider);
        }
        this._renderAll();
    },

    onIdentitySelect(identityProvider, oauthProvider) {
        RegisterState.set('identity_provider', identityProvider);
        RegisterState.set('oauth_provider', oauthProvider);
        this._renderAll();
    },

    onExecutorSelect(value) {
        RegisterState.set('executor_type', value);
        this._renderAll();
    },

    onFieldChange(key, value) {
        RegisterState.set(key, value);
        if (key === 'mail_provider') _applyMailProviderDefaults(value);
        if (key === 'sms_provider') _applySmsProviderDefaults(value);
        this._renderAll();
    },

    // ============================================================
    // æäº¤ä»»åŠ¡
    // ============================================================

    async submit() {
        const form = RegisterState.getForm();
        if (!form.platform) {
            RegisterState.addLog('warning', 'è¯·é€‰æ‹©å¹³å°');
            this._renderAll();
            return;
        }

        RegCardSummary.setButtonLoading(true);

        const extra = {
            identity_provider: form.identity_provider,
            oauth_provider: form.oauth_provider,
            oauth_email_hint: form.oauth_email_hint || undefined,
            chrome_user_data_dir: form.chrome_user_data_dir || undefined,
            chrome_cdp_url: form.chrome_cdp_url || undefined,
        };
        if (form.mail_provider) extra.mail_provider = form.mail_provider;
        if (form.sms_provider) extra.sms_provider = form.sms_provider;

        const payload = {
            platform: form.platform,
            email: form.email || null,
            password: form.password || null,
            count: form.count,
            proxy: form.proxy || null,
            executor_type: form.executor_type || 'protocol',
            captcha_solver: 'auto',
            extra,
        };

        RegisterState.addLog('info', `æäº¤æ³¨å†Œä»»åŠ¡: ${form.platform} x${form.count}`);

        try {
            const task = await RegisterApi.submitTask(payload);
            RegisterState.setTask(task);
            RegisterState.setPolling(true);
            RegisterState.addLog('info', `ä»»åŠ¡å·²åˆ›å»º: ${task.id}`);
            RegisterState.startPolling(() => this._pollTask(task.id));
            this._renderAll();
        } catch (e) {
            RegisterState.addLog('error', `æäº¤å¤±è´¥: ${e.message}`);
            RegCardSummary.setButtonLoading(false);
            this._renderAll();
        }
    },

    async _pollTask(taskId) {
        if (!RegisterState.isPolling()) return;
        try {
            const latest = await RegisterApi.getTask(taskId);
            RegisterState.setTask(latest);

            const events = await RegisterApi.getTaskEvents(taskId);
            (events || []).forEach(ev => {
                const msg = ev.message || JSON.stringify(ev.detail_json || ev.detail || {});
                RegisterState.addLog(_mapLogLevel(ev.level), msg);
            });

            if (isTerminalTaskStatus(latest.status)) {
                RegisterState.setPolling(false);
                RegisterState.markTerminalTask(String(taskId));
                const ok = latest.status === 'succeeded';
                RegisterState.addLog(ok ? 'success' : 'error',
                    `ä»»åŠ¡ç»“æŸ: ${latest.status} (æˆåŠŸ ${latest.success_count || 0}, å¤±è´¥ ${latest.error_count || 0})`);
                if (ok && latest.cashier_urls?.length > 0) {
                    const key = String(taskId);
                    if (!RegisterState.isCashierOpened(key)) {
                        RegisterState.markCashierOpened(key);
                        latest.cashier_urls.forEach(url => window.open(url, '_blank'));
                    }
                }
            }
            this._renderAll();
        } catch (e) {
            RegisterState.addLog('error', `è½®è¯¢å‡ºé”™: ${e.message}`);
        }
    },

    clearLogs() {
        RegisterState.clearLogs();
        this._renderAll();
    },

    destroy() {
        RegisterState.destroy();
        this._initialized = false;
    },
};

// ============================================================
// è¾…åŠ©å‡½æ•°
// ============================================================

function _getDefaultProviderKey(settings = []) {
    const def = settings.find(s => s.is_default);
    return def ? def.provider_key : (settings[0] ? settings[0].provider_key : '');
}

function _hasReusableOAuthBrowser(form) {
    return Boolean(
        (form.chrome_user_data_dir || '').trim() ||
        (form.chrome_cdp_url || '').trim(),
    );
}

function _applyMailProviderDefaults(providerKey) {
    const opts = RegisterState.getConfigOptions() || {};
    const settings = opts.mailbox_settings || [];
    const setting = settings.find(s => s.provider_key === providerKey);
    if (!setting) return;
    const merged = getProviderMergedValues(setting);
    const provider = (opts.mailbox_providers || []).find(p => p.value === providerKey);
    if (!provider) return;
    (provider.fields || []).forEach(field => {
        const val = merged[field.key] ?? RegisterState.get(field.key) ?? '';
        RegisterState.set(field.key, val);
    });
}

function _applySmsProviderDefaults(providerKey) {
    const opts = RegisterState.getConfigOptions() || {};
    const settings = opts.sms_settings || [];
    const setting = settings.find(s => s.provider_key === providerKey);
    if (!setting) return;
    const merged = getProviderMergedValues(setting);
    const provider = (opts.sms_providers || []).find(p => p.value === providerKey);
    if (!provider) return;
    (provider.fields || []).forEach(field => {
        const val = merged[field.key] ?? RegisterState.get(field.key) ?? '';
        RegisterState.set(field.key, val);
    });
}

function _mapLogLevel(level) {
    const map = {
        info: 'info', debug: 'debug', warning: 'warning', error: 'error',
        warn: 'warning', err: 'error', success: 'success', ok: 'success',
    };
    return map[level?.toLowerCase()] || 'info';
}

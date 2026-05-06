/**
 * 注册模式 Tab 主入口
 * 每个卡片渲染逻辑拆分到 cards/ 目录下独立文件
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
    // 数据加载（后台静默，不阻塞 UI）
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
                options ? '' : '无法加载 provider 元数据，请先配置相关 provider',
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
            console.error('[Register] 加载失败:', e);
            this._renderAll();
        }
    },

    // ============================================================
    // 全量渲染
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

        const summaryRegistration = (registrationOptions || []).find(o =>
            o.identityProvider === form.identity_provider && o.oauthProvider === form.oauth_provider,
        )?.label || '-';

        const summaryExecutor = (executorOptions || []).find(o => o.value === form.executor_type)?.label || '-';
        const summaryVerification = getCaptchaStrategyLabel(
            form.executor_type,
            configOptions.captcha_policy,
            configOptions.captcha_providers,
        );

        // 各卡片独立渲染
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
    // 事件处理
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
    // 提交任务
    // ============================================================

    async submit() {
        const form = RegisterState.getForm();
        if (!form.platform) {
            RegisterState.addLog('warning', '请选择平台');
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

        RegisterState.addLog('info', `提交注册任务: ${form.platform} x${form.count}`);

        try {
            const task = await RegisterApi.submitTask(payload);
            RegisterState.setTask(task);
            RegisterState.setPolling(true);
            RegisterState.addLog('info', `任务已创建: ${task.id}`);
            RegisterState.startPolling(() => this._pollTask(task.id));
            this._renderAll();
        } catch (e) {
            RegisterState.addLog('error', `提交失败: ${e.message}`);
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
                    `任务结束: ${latest.status} (成功 ${latest.success_count || 0}, 失败 ${latest.error_count || 0})`);
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
            RegisterState.addLog('error', `轮询出错: ${e.message}`);
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
// 辅助函数
// ============================================================

function _getDefaultProviderKey(settings = []) {
    if (!Array.isArray(settings)) return '';
    const def = settings.find(s => s && s.is_default);
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
    if (!Array.isArray(settings)) return;
    const setting = settings.find(s => s && s.provider_key === providerKey);
    if (!setting) return;
    const merged = getProviderMergedValues(setting);
    const provider = (opts.mailbox_providers || []).find(p => p && p.value === providerKey);
    if (!provider) return;
    (provider.fields || []).forEach(field => {
        const val = merged[field.key] ?? RegisterState.get(field.key) ?? '';
        RegisterState.set(field.key, val);
    });
}

function _applySmsProviderDefaults(providerKey) {
    const opts = RegisterState.getConfigOptions() || {};
    const settings = opts.sms_settings || [];
    if (!Array.isArray(settings)) return;
    const setting = settings.find(s => s && s.provider_key === providerKey);
    if (!setting) return;
    const merged = getProviderMergedValues(setting);
    const provider = (opts.sms_providers || []).find(p => p && p.value === providerKey);
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

/**
 * 注册配置选项构建
 * 负责根据当前平台和表单状态构建各种下拉选项
 */

/**
 * 获取默认 provider key
 */
function getDefaultProviderKey(settings = []) {
    if (!Array.isArray(settings)) return '';
    const def = settings.find(s => s && s.is_default);
    return def ? def.provider_key : (settings[0] ? settings[0].provider_key : '');
}

/**
 * 获取 provider 的合并配置值
 */
function getProviderMergedValues(setting) {
    return {
        ...(setting?.config || {}),
        ...(setting?.auth || {}),
    };
}

/**
 * 获取 provider 设置
 */
function getProviderSetting(settings = [], providerKey) {
    if (!Array.isArray(settings)) return null;
    return settings.find(s => s && s.provider_key === providerKey) || null;
}

/**
 * 获取 provider 下拉选项
 */
function getProviderSelectOptions(providers = []) {
    return providers.map(p => ({
        value: p.value || p.provider_key || '',
        label: p.label || p.provider_key || '',
    }));
}

/**
 * 获取验证码策略标签
 */
function getCaptchaStrategyLabel(executorType, captchaPolicy, captchaProviders) {
    if (executorType === 'protocol') {
        const policy = captchaPolicy || {};
        const primary = policy.primary || '';
        const providers = captchaProviders || [];
        const prov = providers.find(p => p.value === primary);
        return prov ? prov.label : (primary || '自动');
    }
    return '浏览器自动';
}

/**
 * 构建注册方式选项（Step 1）
 * 参考 any-auto-register 的 RegistrationOptions 逻辑
 */
function buildRegistrationOptions(platform) {
    if (!platform) return [];

    const opts = [];
    const identityModes = platform.supported_identity_modes || [];
    const oauthProviders = platform.supported_oauth_providers || [];

    if (!Array.isArray(identityModes)) return opts;

    if (identityModes.includes('mailbox')) {
        opts.push({
            key: 'mailbox',
            identityProvider: 'mailbox',
            oauthProvider: '',
            label: '邮箱注册',
            description: '使用临时邮箱接收验证码，自动完成注册',
            icon: 'mail',
        });
    }

    if (identityModes.includes('oauth_browser') && Array.isArray(oauthProviders)) {
        oauthProviders.forEach(provider => {
            opts.push({
                key: `oauth_${provider}`,
                identityProvider: 'oauth_browser',
                oauthProvider: provider,
                label: `${getOAuthProviderLabel(provider)} 登录`,
                description: '通过 OAuth 直接登录，无需邮箱验证',
                icon: 'shield',
            });
        });
    }

    return opts;
}

/**
 * OAuth Provider 名称映射
 */
function getOAuthProviderLabel(provider) {
    const map = {
        google: 'Google',
        microsoft: 'Microsoft',
        apple: 'Apple',
        github: 'GitHub',
    };
    return map[provider] || provider;
}

/**
 * 构建执行通道选项（Step 2）
 * 参考 any-auto-register 的 executorOptions 逻辑
 */
function buildExecutorOptions(identityProvider, supportedExecutors = [], hasReusableBrowser = false, platformExecutorOptions = []) {
    const allOptions = [
        {
            value: 'protocol',
            label: '协议模式',
            description: '直接发送 HTTP 请求，速度最快',
            icon: 'protocol',
        },
        {
            value: 'headless',
            label: '无头浏览器',
            description: 'Playwright 无界面浏览器，支持 JS 渲染',
            icon: 'headless',
        },
        {
            value: 'headed',
            label: '有头浏览器',
            description: '可见浏览器窗口，方便调试',
            icon: 'headed',
        },
    ];

    const valid = supportedExecutors || ['protocol'];

    return allOptions.map(opt => {
        const supported = valid.includes(opt.value);
        let reason = '';
        if (!supported) {
            reason = '当前平台不支持此执行模式';
        }
        return {
            ...opt,
            disabled: !supported,
            reason,
        };
    });
}

/**
 * 构建任务统计信息
 */
function buildTaskStats(task) {
    if (!task) return [];

    const statusLabels = {
        pending: '等待中',
        started: '进行中',
        running: '进行中',
        succeeded: '成功',
        failed: '失败',
        cancelled: '已取消',
        interrupted: '已中断',
    };

    return [
        {
            label: '状态',
            value: statusLabels[task.status] || task.status || '-',
            icon: 'orbit',
        },
        {
            label: '进度',
            value: `${task.progress_current || 0}/${task.progress_total || task.count || 0}`,
            icon: 'progress',
        },
        {
            label: '成功',
            value: String(task.success_count || 0),
            icon: 'check',
        },
        {
            label: '失败',
            value: String(task.error_count || task.errors?.length || 0),
            icon: 'x',
        },
    ];
}

/**
 * 获取任务终态判断
 */
function isTerminalTaskStatus(status) {
    return ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(status);
}

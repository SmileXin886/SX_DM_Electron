/**
 * Dreamina Toolkit - 登录激活界面渲染逻辑
 * ==========================================
 * 职责：
 * 1. 监听激活按钮点击，获取输入框激活码
 * 2. 通过 window.electronAPI 将激活码发送给 Electron 主进程验证
 * 3. 根据验证结果展示：成功打勾动画 / 失败震动 + 错误提示
 * 4. 纯前端逻辑，不使用 Node.js fs 或写死路径
 */

(function () {
    'use strict';

    /* ======================================================
       0. DOM 引用缓存
       ====================================================== */
    const $form        = document.getElementById('activationForm');
    const $input       = document.getElementById('licenseKey');
    const $errorMsg    = document.getElementById('errorMsg');
    const $verifyBtn   = document.getElementById('verifyBtn');
    const $btnContent  = document.getElementById('btnContent');
    const $btnLoading  = document.getElementById('btnLoading');
    const $btnSuccess  = document.getElementById('btnSuccess');
    const $premiumOverlay = document.getElementById('premiumOverlay');
    const $overlayText = document.getElementById('overlayText');

    /* ======================================================
       1. 激活码格式化（每 4 位自动插入分隔符）
       ====================================================== */
    $input.addEventListener('input', function (e) {
        // 过滤非法字符（只允许字母和数字）
        let raw = e.target.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();

        // 自动插入分隔符 XXXX-XXXX-XXXX-XXXX
        const formatted = raw.replace(/(.{4})/g, '$1-').replace(/-$/, '');

        // 同步更新显示值（避免光标跳位，手动设置 selection）
        const pos = e.target.selectionStart;
        const prevLen = e.target.value.length;
        e.target.value = formatted;

        // 重新校准光标位置
        const newLen = formatted.length;
        const diff = newLen - prevLen;
        e.target.setSelectionRange(pos + diff, pos + diff);
    });

    /* ======================================================
       2. 键盘支持：回车键直接触发验证
       ====================================================== */
    $input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            $form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        }
    });

    /* ======================================================
       3. 表单提交：核心验证流程
       ====================================================== */
    $form.addEventListener('submit', async function (e) {
        e.preventDefault();

        const rawKey = $input.value.trim();

        // ---- 前置校验 ----
        if (!rawKey) {
            showError('Please enter your activation code.');
            shakeInput();
            $input.focus();
            return;
        }

        // 去除格式化的分隔符，提交原始激活码
        const cleanKey = rawKey.replace(/-/g, '');

        // 需要 16 个字符 + 3 个横杠 = 19 位完整格式
        if (cleanKey.length < 16) {
            showError('请输入完整的 16 位激活码');
            shakeInput();
            return;
        }

        // ---- 进入加载状态 ----
        clearError();
        setButtonState('loading');
        showPremiumLoading('Verifying Activation Code...');

        try {
            /* ---------------------------------------------------------
               4. 桥接主进程：通过 window.electronAPI 发起 IPC 验证
               - 不使用 fs，不写死路径
               - 完整走 preload.js 暴露的安全通道
               --------------------------------------------------------- */
            // 直接传递带横杠的完整激活码 rawKey，以匹配 Cloudflare KV 数据库中的键名
            const result = await window.electronAPI.verifyLicense(rawKey);

            if (result && result.success) {
                await handleSuccess(result);
            } else {
                handleFailure(result && result.error
                    ? result.error
                    : '验证失败，请检查激活码或网络');
            }
        } catch (err) {
            // 网络或通信异常
            console.error('[Login] Verification error:', err);
            handleFailure('安全连接异常：' + err.message);
        }
    });

    /* ======================================================
       4. 状态管理：按钮三态切换（默认 / 加载中 / 成功）
       ====================================================== */
    function setButtonState(state) {
        // state 可选值: 'normal', 'loading', 'success'
        $btnContent.style.display = state === 'normal' ? 'flex' : 'none';
        $btnLoading.style.display = state === 'loading' ? 'flex' : 'none';
        $btnSuccess.style.display = state === 'success' ? 'flex' : 'none';

        // 验证期间或成功后锁定输入框和按钮
        $input.disabled = state !== 'normal';
        $verifyBtn.disabled = state !== 'normal';
    }

    // 兼容旧函数：Loading 状态通过 setButtonState 实现
    function setLoadingState(loading) {
        setButtonState(loading ? 'loading' : 'normal');
    }

    // 兼容旧函数：成功状态切换
    function enterSuccessState() {
        setButtonState('success');
    }

    /* ======================================================
       5. 状态管理：验证成功
       ====================================================== */
    async function handleSuccess(result) {
        clearError();

        // 切换为绿色打勾状态（通过按钮三态控制）
        enterSuccessState();

        // 遮罩保持显示，更新文字
        $overlayText.textContent = 'Verification Successful! Launching...';

        // 延迟跳转主应用（让用户看到成功动画）
        await sleep(1500);

        /* ---------------------------------------------------------
           通知主进程：验证成功，可以切换到主界面
           主进程收到此事件后，执行窗口内容切换
           --------------------------------------------------------- */
        if (window.electronAPI && typeof window.electronAPI.notifyActivationSuccess === 'function') {
            window.electronAPI.notifyActivationSuccess(result);
        } else {
            // 降级：直接刷新当前页面到主界面
            console.warn('[Login] notifyActivationSuccess not available, reloading...');
            window.location.reload();
        }
    }

    /* ======================================================
       6. 状态管理：验证失败
       ====================================================== */
    function handleFailure(message) {
        hidePremiumLoading();
        setLoadingState(false);
        showError(message);
        shakeInput();
    }

    /* ======================================================
       7. 错误提示展示
       ====================================================== */
    function showError(msg) {
        $errorMsg.textContent = msg;
        $errorMsg.classList.add('visible');
    }

    function clearError() {
        $errorMsg.textContent = '';
        $errorMsg.classList.remove('visible');
    }

    /* ======================================================
       8. 输入框震动动画（验证失败反馈）
       ====================================================== */
    function shakeInput() {
        // 清除已有动画，确保可重复触发
        $input.classList.remove('shake');
        // 强制 reflow，立即重置动画状态
        void $input.offsetWidth;
        $input.classList.add('shake');

        // 动画结束后（0.55s）移除类，以便下次重试可再次触发
        $input.addEventListener('animationend', function handler() {
            $input.classList.remove('shake');
            $input.removeEventListener('animationend', handler);
        });
    }

    /* ======================================================
       9. 工具函数
       ====================================================== */
    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /* ======================================================
       9b. 高级加载遮罩控制函数
       ====================================================== */
    function showPremiumLoading(text) {
        $overlayText.textContent = text || 'Authenticating Secure Connection...';
        $premiumOverlay.classList.add('active');
    }

    function hidePremiumLoading() {
        $premiumOverlay.classList.remove('active');
    }

    /* ======================================================
       10. 页面就绪：自动聚焦输入框 + 监听云端查岗失效事件
       ====================================================== */
    window.addEventListener('DOMContentLoaded', function () {
        // 短暂延迟确保 CSS 动画先触发
        setTimeout(function () {
            $input.focus();
        }, 350);

        // 监听主进程推送的"授权已失效"事件（二次启动时云端查岗失败）
        if (window.electronAPI && typeof window.electronAPI.on === 'function') {
            // 监听启动静默查岗
            window.electronAPI.on('login:silent-verify-start', function () {
                showPremiumLoading('Verifying Cloud License...');
            });

            // 现有的 auth-invalid 监听
            window.electronAPI.on('login:auth-invalid', function (message) {
                hidePremiumLoading();
                setButtonState('normal');
                showError(message || '授权已失效，请重新激活');
                shakeInput();
            });
        }
    });

})();

/**
 * points_tracker/index.js - 积分追踪模块入口
 * 负责组装 overlay_window 和 cdp_interceptor，向外暴露单一挂载函数
 */
const { setupCdpInterceptor } = require('./cdp_interceptor');
const { createOverlayWindow } = require('./overlay_window');

const logger = {
    info: (...a) => console.log('[PointsTracker]', new Date().toLocaleTimeString('zh-CN', { hour12: false }), ...a),
    warn: (...a) => console.warn('[PointsTracker]', ...a),
    error: (...a) => console.error('[PointsTracker]', ...a),
};

/**
 * 挂载积分追踪器到即梦安全浏览器窗口
 * 在 browser_launcher.js 的 did-finish-load 回调中调用此函数
 *
 * @param {BrowserWindow} parentWin - 即梦安全浏览器窗口（由 startSecureBrowser 创建）
 * @param {string} accountId - 账号 ID（用于日志标识）
 * @returns {{ destroy: () => void }} 销毁函数，窗口关闭时调用
 */
function attachTracker(parentWin, accountId) {
    if (parentWin.isDestroyed()) {
        logger.warn('父窗口已销毁，跳过挂载');
        return { destroy: () => {} };
    }

    logger.info(`开始挂载积分追踪器 (accountId=${accountId})`);

    // 1. 创建透明悬浮窗
    const overlayWin = createOverlayWindow(parentWin);

    // 2. 构造积分更新回调：通过 IPC 发送到悬浮窗
    function onPointsUpdate(pointsData) {
        if (overlayWin.isDestroyed()) return;
        try {
            overlayWin.webContents.send('tracker:update-points', pointsData);
        } catch (e) {
            logger.warn('积分更新推送失败:', e.message);
        }
    }

    // 3. 挂载 CDP 拦截器
    const { detach: detachCdp } = setupCdpInterceptor(parentWin, onPointsUpdate);

    // 4. 清理函数：窗口关闭时统一拆除所有组件
    function destroy() {
        logger.info(`销毁积分追踪器 (accountId=${accountId})`);
        detachCdp();
        if (!overlayWin.isDestroyed()) {
            overlayWin._cleanup ? overlayWin._cleanup() : overlayWin.destroy();
        }
    }

    // 监听父窗口关闭，自动清理
    const onParentClose = () => destroy();
    parentWin.once('closed', onParentClose);

    logger.info(`积分追踪器挂载完成 (accountId=${accountId})`);

    return { destroy };
}

module.exports = { attachTracker };

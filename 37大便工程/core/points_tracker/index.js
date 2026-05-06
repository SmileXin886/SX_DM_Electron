/**
 * points_tracker/index.js - 积分追踪模块入口
 * ==========================================
 * 职责：组装所有子模块，按正确顺序初始化
 *
 * 初始化顺序（重要）：
 * 1. init(app)           → TaskLedger 初始化账本路径，加载历史
 * 2. HistorySync.init()   → HistorySync 注册 ledger 事件监听
 * 3. setupCdpInterceptor() → 纯网络拦截，开始工作
 *
 * 模块职责边界：
 * - TaskLedger      : 内存状态 + 磁盘持久化 + 双向绑定 + 等待室
 * - HistorySync     : 历史追溯 + 对账 + 积分核算 + UI 推送
 * - CdpInterceptor  : CDP 网络拦截 + 数据提取 + Ledger 操作
 */
const { app } = require('electron');
const { setupCdpInterceptor } = require('./cdp_interceptor');
const { createOverlayWindow } = require('./overlay_window');
const TaskLedger = require('./task_ledger');
const HistorySync = require('./history_sync');

const logger = {
    info: (...a) => console.log('[PointsTracker]', new Date().toLocaleTimeString('zh-CN', { hour12: false }), ...a),
    warn: (...a) => console.warn('[PointsTracker]', ...a),
    error: (...a) => console.error('[PointsTracker]', ...a),
};

// 已挂载的追踪器实例（accountId → { destroy, overlayWin }）
const _instances = new Map();

/**
 * 挂载积分追踪器到即梦安全浏览器窗口
 *
 * @param {BrowserWindow} parentWin
 * @param {string} accountId
 * @returns {{ destroy: () => void }}
 */
function attachTracker(parentWin, accountId) {
    if (parentWin.isDestroyed()) {
        logger.warn('父窗口已销毁，跳过挂载');
        return { destroy: () => {} };
    }

    logger.info(`开始挂载积分追踪器 (accountId=${accountId})`);

    // 1. 创建透明悬浮窗
    const overlayWin = createOverlayWindow(parentWin);

    // 2. 构造 UI 更新回调：通过 IPC 发送到悬浮窗
    function onPointsUpdate(pointsData) {
        if (overlayWin.isDestroyed()) return;
        try {
            overlayWin.webContents.send('tracker:update-points', pointsData);
        } catch (e) {
            logger.warn('积分更新推送失败:', e.message);
        }
    }

    // 3. 初始化 HistorySync（传入回调）
    // 注意：HistorySync.init 必须在 setupCdpInterceptor 之前调用，
    // 因为 CDP 的事件处理器中会引用 HistorySync
    HistorySync.init(onPointsUpdate);

    // 4. 挂载 CDP 拦截器
    const { detach: detachCdp } = setupCdpInterceptor(parentWin, onPointsUpdate);

    // 5. 清理函数
    function destroy() {
        logger.info(`销毁积分追踪器 (accountId=${accountId})`);
        detachCdp();
        if (!overlayWin.isDestroyed()) {
            overlayWin._cleanup ? overlayWin._cleanup() : overlayWin.destroy();
        }
    }

    parentWin.once('closed', destroy);
    _instances.set(accountId, { destroy });

    logger.info(`积分追踪器挂载完成 (accountId=${accountId})`);
    return { destroy };
}

/**
 * 全局初始化（应用启动时，在 app.whenReady() 之后调用一次）
 * 必须在 attachTracker 之前执行
 *
 * @param {Electron.App} electronApp
 */
async function initGlobal(electronApp) {
    logger.info('初始化全局积分追踪器...');

    // 1. 初始化账本路径并加载历史数据
    TaskLedger.init(electronApp);
    await TaskLedger.load();

    // 2. 恢复未完成的 pending 任务（程序重启后追溯烂账）
    const pending = TaskLedger.getAllPendingTasks();
    if (pending.length > 0) {
        logger.info(`发现 ${pending.length} 条未完成的 pending 任务，将在后继账单中追溯核销`);
        for (const task of pending) {
            logger.info(`  - ${task.taskKey} | ${task.agentMode} | ${task.status} | ${new Date(task.timestamp).toLocaleString('zh-CN')}`);
        }
    }
}

/**
 * 全局清理（应用退出前调用）
 */
async function destroyGlobal() {
    logger.info('清理全局积分追踪器...');
    // 确保账本最后一次写入落盘
    await TaskLedger.flushSync();
    // 销毁所有实例
    for (const { destroy } of _instances.values()) {
        destroy();
    }
    _instances.clear();
}

module.exports = {
    attachTracker,
    initGlobal,
    destroyGlobal,
};

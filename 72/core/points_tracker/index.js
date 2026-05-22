/**
 * points_tracker/index.js - 积分追踪模块入口
 * ==========================================
 * 职责：组装所有子模块，按正确顺序初始化
 *
 * 初始化顺序（重要）：
 * 1. initGlobal(app)        → TaskLedger 初始化账本路径，加载历史
 * 2. attachTracker(parentWin, accountId) → 注册账号窗口，启动所有拦截器
 *
 * 全局单例悬浮窗架构：
 * - 全局只有一个 BrowserWindow，通过 focus 事件动态切换归属
 * - 所有 attachTracker 实例共享同一个 overlay，积分自然累加
 * - latestPointsMap 维护每个账号的最新积分，切换窗口时恢复 UI 数字
 */
const { app } = require('electron');
const { setupCdpInterceptor } = require('./cdp_interceptor');
const { attachToWindow, detachWindow, sendProfileUpdate, sendPointsUpdate, updatePointsSnapshot } = require('./overlay_window');
const TaskLedger = require('./task_ledger');
const { setupHistorySync } = require('./history_sync');
const { setupAgentReconciler } = require('./agent_reconciler');
// 画布拦截器已迁移至 browser_launcher.js 统一网关，index.js 不再管理

const logger = {
    info: (...a) => console.log('[PointsTracker]', new Date().toLocaleTimeString('zh-CN', { hour12: false }), ...a),
    warn: (...a) => console.warn('[PointsTracker]', ...a),
    error: (...a) => console.error('[PointsTracker]', ...a),
};

// 已挂载的追踪器实例（accountId → destroy）
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

    // 1. 注册到全局悬浮窗管理器（不再自己创建窗口）
    attachToWindow(parentWin, accountId, () => {
        // getLatestPointsCallback：返回该账号最新积分（用于切换时恢复 UI）
        return _latestPointsMap.get(accountId);
    });

    // 2. 构造 UI 更新回调：所有事件统一发送到唯一全局悬浮窗
    function onPointsUpdate(pointsData) {
        // 🌟 新增：确保每个发往前端的事件都带有当前窗口的 accountId
        pointsData.accountId = accountId;

        // 保存 sync 事件的积分快照
        if (pointsData.type === 'sync' && typeof pointsData.currentPoints === 'number') {
            updatePointsSnapshot(accountId, pointsData.currentPoints);
        }
        // 推送积分事件到全局悬浮窗
        sendPointsUpdate(pointsData);
    }

    // 3. 头像/昵称推送回调：主进程触发时直接推送
    function onProfileUpdate(nickname, avatarPath) {
        sendProfileUpdate(nickname, avatarPath);
    }

    // 4. 初始化 HistorySync（传入回调和账号 ID）- 多实例工厂模式
    const historySync = setupHistorySync(onPointsUpdate, accountId);

    // 5. 初始化 Agent 延迟追溯对账（2分钟轮询）- 多实例工厂模式
    const reconciler = setupAgentReconciler(parentWin, onPointsUpdate, accountId);

    // 6. 挂载 CDP 拦截器（传入 historySync 实例）
    const { detach: detachCdp } = setupCdpInterceptor(parentWin, onPointsUpdate, accountId, historySync);

    // 7. 清理函数
    function destroy() {
        logger.info(`销毁积分追踪器 (accountId=${accountId})`);
        historySync.destroy();
        reconciler.stop();
        detachCdp();
        detachWindow(accountId);
    }

    parentWin.once('closed', destroy);
    _instances.set(accountId, destroy);

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
    await TaskLedger.flushSync();
    for (const destroy of _instances.values()) {
        destroy();
    }
    _instances.clear();
}

// ═══════════════════════════════════════════════════════════════
// 头像/昵称外部注入接口（由 main.js 调用，触发悬浮窗 UI 更新）
// ═══════════════════════════════════════════════════════════════
function notifyProfileUpdate(nickname, avatarPath) {
    sendProfileUpdate(nickname, avatarPath);
}

module.exports = {
    attachTracker,
    initGlobal,
    destroyGlobal,
    notifyProfileUpdate,
};

/**
 * overlay_window.js - 全局单例悬浮窗管理器
 * ===========================================
 * 职责：
 * - 仅创建一次 BrowserWindow（透明、Frameless、AlwaysOnTop）
 * - 监听所有账号窗口的 focus 事件，动态切换归属
 * - 当窗口获得焦点时：重新父窗口 + 定位到右上角 + 推送账号信息 + 推送当前积分
 */
const { BrowserWindow } = require('electron');
const path = require('path');
const { getAccountManager } = require('../account_manager');

const OVERLAY_WIDTH = 400;
const OVERLAY_HEIGHT = 560;
const MARGIN_RIGHT = 16;
const MARGIN_TOP = 60;

const logger = {
    info: (...a) => console.log('[GlobalOverlay]', new Date().toLocaleTimeString('zh-CN', { hour12: false }), ...a),
    warn: (...a) => console.warn('[GlobalOverlay]', ...a),
    error: (...a) => console.error('[GlobalOverlay]', ...a),
};

/** @type {BrowserWindow|null} */
let overlay = null;
/** @type {Map<string, { parentWin: BrowserWindow, focusUnlisten: Function }>} */
const _windowMap = new Map();

/** 悬浮窗是否已完成首次定位（完成后不再强制吸附右上角） */
let _hasBeenPositioned = false;

/** 全局积分快照（每个账号的最新积分），用于切换窗口时恢复 UI 数字 */
let _latestPointsMap = new Map();

/** 创建唯一的悬浮窗（惰性创建，仅一次） */
function _ensureOverlay() {
    if (overlay && !overlay.isDestroyed()) return overlay;

    const preloadPath = path.join(__dirname, 'preload_overlay.js');
    overlay = new BrowserWindow({
        width: OVERLAY_WIDTH,
        height: OVERLAY_HEIGHT,
        // 注意：不再设置 parent，悬浮窗独立存在
        modal: false,
        transparent: true,
        frame: false,
        alwaysOnTop: true,
        focusable: false,
        resizable: false,
        hasShadow: false,
        skipTaskbar: true,
        show: false,
        backgroundColor: '#00000000',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            preload: preloadPath,
        },
    });

    overlay.once('ready-to-show', () => {
        overlay.show();
        logger.info('全局悬浮窗已创建并显示');
    });

    const htmlPath = path.join(__dirname, '..', '..', 'web_ui', 'tracker', 'tracker.html');
    overlay.loadURL(`file://${htmlPath}`).catch(err => {
        logger.error('悬浮窗 HTML 加载失败:', err.message);
    });

    overlay.on('closed', () => {
        overlay = null;
        _hasBeenPositioned = false;
        _windowMap.forEach((info) => {
            if (info.focusUnlisten) info.focusUnlisten();
        });
        _windowMap.clear();
        logger.info('全局悬浮窗已销毁');
    });

    return overlay;
}

/** 将悬浮窗定位到目标窗口的右上角 */
function _positionAtTopRight(parentWin) {
    if (!overlay || overlay.isDestroyed() || parentWin.isDestroyed()) return;
    const [pX, pY] = parentWin.getPosition();
    const [pW] = parentWin.getSize();
    overlay.setPosition(
        pX + pW - OVERLAY_WIDTH - MARGIN_RIGHT,
        pY + MARGIN_TOP
    );
}

/**
 * 向 renderer 发送头像/昵称更新
 * @param {string} nickname
 * @param {string|null} avatarPath
 */
function sendProfileUpdate(nickname, avatarPath) {
    _ensureOverlay();
    if (overlay.isDestroyed()) return;
    try {
        overlay.webContents.send('tracker:update-profile', { nickname, avatarPath });
    } catch (e) {
        logger.warn('Profile 更新推送失败:', e.message);
    }
}

/**
 * 向 renderer 发送积分更新（所有事件统一走这里）
 * @param {object} pointsData
 */
function sendPointsUpdate(pointsData) {
    _ensureOverlay();
    if (overlay.isDestroyed()) return;
    try {
        // 🌟 新增：拦截并注入账号的头像和昵称信息
        if (pointsData.accountId) {
            try {
                const am = getAccountManager();
                const acc = am._accounts.find(a => a.id === pointsData.accountId);
                if (acc) {
                    pointsData.nickname = acc.nickname || acc.name;
                    pointsData.avatarPath = acc.avatarPath;
                }
            } catch (e) {}
        }

        overlay.webContents.send('tracker:update-points', pointsData);
    } catch (e) {
        logger.warn('积分更新推送失败:', e.message);
    }
}

/**
 * 更新某账号的积分快照（用于切换窗口时恢复 UI 数字）
 * @param {string} accountId
 * @param {number} currentPoints
 */
function updatePointsSnapshot(accountId, currentPoints) {
    _latestPointsMap.set(accountId, currentPoints);
}

/**
 * 注册一个账号窗口到全局悬浮窗管理器
 * @param {BrowserWindow} parentWin - 即梦安全浏览器窗口
 * @param {string} accountId - 账号 ID
 * @param {Function} getLatestPointsCallback - 返回该账号最新积分的回调
 */
function attachToWindow(parentWin, accountId, getLatestPointsCallback) {
    if (parentWin.isDestroyed()) {
        logger.warn('父窗口已销毁，跳过注册:', accountId);
        return;
    }

    _ensureOverlay();
    logger.info(`注册账号窗口 (accountId=${accountId})`);

    // 清理旧绑定（同一 accountId 重复调用时）
    if (_windowMap.has(accountId)) {
        const old = _windowMap.get(accountId);
        if (old.focusUnlisten) old.focusUnlisten();
        _windowMap.delete(accountId);
    }

    // 监听父窗口获得焦点
    const onFocus = () => {
        if (overlay.isDestroyed() || parentWin.isDestroyed()) return;

        // 仅首次定位到右上角，后续保持用户拖拽位置
        if (!_hasBeenPositioned) {
            _positionAtTopRight(parentWin);
            _hasBeenPositioned = true;
        }

        const pushData = () => {
            if (overlay.isDestroyed() || parentWin.isDestroyed()) return;

            // 🌟 修复：增加强力容错，绝不让获取头像失败导致积分停止刷新
            try {
                const am = getAccountManager();
                // 兼容不同版本的 account_manager 实现
                const acctInfo = typeof am.getAccountInfo === 'function'
                    ? am.getAccountInfo(accountId)
                    : am._accounts.find(a => a.id === accountId);

                if (acctInfo) {
                    sendProfileUpdate(acctInfo.nickname || acctInfo.name || '即梦用户', acctInfo.avatarPath);
                }
            } catch (e) {
                logger.warn('拉取账号缓存头像失败，但不影响积分刷新', e.message);
            }

            // 推送该账号的最新积分（恢复数字）
            const pts = _latestPointsMap.get(accountId);
            if (pts !== undefined) {
                sendPointsUpdate({ type: 'sync', currentPoints: pts });
            }
        };

        // 【核心修复】：如果是第一次创建悬浮窗，还在加载中，立刻发送会丢失消息，必须等加载完成
        if (overlay.webContents.isLoading()) {
            overlay.webContents.once('did-finish-load', pushData);
        } else {
            pushData();
        }

        // 显示悬浮窗
        overlay.show();
    };

    parentWin.on('focus', onFocus);

    _windowMap.set(accountId, {
        parentWin,
        focusUnlisten: () => parentWin.off('focus', onFocus),
    });

    // 如果当前焦点窗口就是此窗口，立即触发一次切换
    if (parentWin.isFocused()) {
        onFocus();
    }
}

/**
 * 解绑账号窗口
 * @param {string} accountId
 */
function detachWindow(accountId) {
    if (!_windowMap.has(accountId)) return;
    const info = _windowMap.get(accountId);
    if (info.focusUnlisten) info.focusUnlisten();
    _windowMap.delete(accountId);
    logger.info(`解绑账号窗口 (accountId=${accountId})`);

    // 所有账号窗口都关闭了，彻底销毁悬浮窗
    if (_windowMap.size === 0 && overlay && !overlay.isDestroyed()) {
        overlay.destroy();
        _hasBeenPositioned = false; // 🌟 修复：彻底重置状态，保证下次打开依然能正确出生在右上角
        logger.info('所有账号窗口已关闭，销毁全局悬浮窗');
    }
}

/**
 * 销毁全局悬浮窗
 */
function destroyAll() {
    if (overlay && !overlay.isDestroyed()) {
        overlay.destroy();
    }
    overlay = null;
    _hasBeenPositioned = false;
    _windowMap.forEach((info) => {
        if (info.focusUnlisten) info.focusUnlisten();
    });
    _windowMap.clear();
    _latestPointsMap.clear();
}

module.exports = { attachToWindow, detachWindow, sendProfileUpdate, sendPointsUpdate, updatePointsSnapshot, destroyAll };

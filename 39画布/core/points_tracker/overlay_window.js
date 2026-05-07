/**
 * overlay_window.js - 透明悬浮子窗口管理
 * 负责创建、定位、同步、拖拽透明计分板窗口
 */
const { BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const OVERLAY_WIDTH = 340;
const OVERLAY_HEIGHT = 420;
const MARGIN_RIGHT = 16;
const MARGIN_TOP = 60;

const logger = {
    info: (...a) => console.log('[Overlay]', new Date().toLocaleTimeString('zh-CN', { hour12: false }), ...a),
    warn: (...a) => console.warn('[Overlay]', ...a),
    error: (...a) => console.error('[Overlay]', ...a),
};

/**
 * 创建悬浮子窗口
 * @param {BrowserWindow} parentWin - 即梦安全浏览器窗口（父窗口）
 * @returns {BrowserWindow} overlayWin
 */
function createOverlayWindow(parentWin) {
    // 创建 preload 脚本路径（在 ui/ 同级，名为 preload_overlay.js）
    const preloadPath = path.join(__dirname, 'preload_overlay.js');

    const overlay = new BrowserWindow({
        width: OVERLAY_WIDTH,
        height: OVERLAY_HEIGHT,
        // 子窗口配置
        parent: parentWin,
        modal: false,
        // 透明关键配置
        transparent: true,
        frame: false,
        // 悬浮特性
        alwaysOnTop: true,
        focusable: false,
        resizable: false,
        hasShadow: false,
        skipTaskbar: true,
        show: false,
        // 视觉修正
        backgroundColor: '#00000000',
        // 开发者工具（调试用，完成后可关闭）
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            preload: preloadPath,
        },
    });

    // 初始定位：父窗口右上角
    function positionAtTopRight() {
        if (overlay.isDestroyed() || parentWin.isDestroyed()) return;
        const [pX, pY] = parentWin.getPosition();
        const [pW] = parentWin.getSize();
        overlay.setPosition(
            pX + pW - OVERLAY_WIDTH - MARGIN_RIGHT,
            pY + MARGIN_TOP
        );
    }

    positionAtTopRight();

    // 父窗口移动时同步子窗口位置
    const onParentMove = () => positionAtTopRight();
    const onParentResize = () => positionAtTopRight();
    parentWin.on('move', onParentMove);
    parentWin.on('resize', onParentResize);

    // 父窗口关闭时销毁悬浮窗
    parentWin.on('closed', () => {
        if (!overlay.isDestroyed()) {
            overlay.destroy();
        }
    });

    // 窗口准备好后显示（带淡入效果可选）
    overlay.once('ready-to-show', () => {
        overlay.show();
        logger.info('悬浮窗已显示');
    });

    // 加载悬浮窗 HTML（位于 web_ui/tracker/ 目录）
    const htmlPath = path.join(__dirname, '..', '..', 'web_ui', 'tracker', 'tracker.html');
    overlay.loadFile(htmlPath).catch(err => {
        logger.error('悬浮窗 HTML 加载失败:', err.message);
    });

    // 清理函数
    function cleanup() {
        parentWin.off('move', onParentMove);
        parentWin.off('resize', onParentResize);
        if (!overlay.isDestroyed()) {
            overlay.destroy();
        }
    }

    overlay._cleanup = cleanup;

    return overlay;
}

module.exports = { createOverlayWindow };

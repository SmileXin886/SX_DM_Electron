/**
 * auth_controller.js - 登录验证与授权控制器
 * ============================================
 * 职责：
 * 1. 软件激活码云端验证（首次激活）
 * 2. 二次启动时云端静默查岗（从 license.json 恢复内存凭证）
 * 3. 注册所有 login: 相关 IPC 通道
 *
 * 使用方式（main.js 中）：
 *   const { asyncSilentReverify } = initAuthSystem({ getMainWindow, WEB_UI_DIR, logger });
 */

const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

// ==================== 许可证文件路径（延迟获取，避免模块加载时序问题）====================
function getLicenseFilePath() {
    return path.join(app.getPath('userData'), 'license.json');
}

// ==================== 辅助函数 ====================

/**
 * 读取本地许可证文件（同步）
 * @param {Function} logger - 外部注入的日志工具
 * @returns {string|null} 激活码字符串，文件不存在或解析失败返回 null
 */
function readLocalLicenseKey(logger) {
    const LICENSE_FILE_PATH = getLicenseFilePath();
    try {
        if (fs.existsSync(LICENSE_FILE_PATH)) {
            const data = JSON.parse(fs.readFileSync(LICENSE_FILE_PATH, 'utf-8'));
            if (data && data.activated === true && data.licenseKey) {
                return data.licenseKey;
            }
        }
    } catch (e) {
        logger.warn('[License] 读取许可证文件失败:', e.message);
    }
    return null;
}

/**
 * 静默删除本地许可证文件（云端查岗失败时调用）
 * @param {Function} logger - 外部注入的日志工具
 */
function deleteLocalLicense(logger) {
    const LICENSE_FILE_PATH = getLicenseFilePath();
    try {
        if (fs.existsSync(LICENSE_FILE_PATH)) {
            fs.unlinkSync(LICENSE_FILE_PATH);
            logger.info('[License] 已删除本地许可证文件');
        }
    } catch (e) {
        logger.error('[License] 删除许可证文件失败:', e.message);
    }
}

/**
 * 设置窗口副标题显示授权到期时间
 * @param {Function} getMainWindow - 获取主窗口的函数
 * @param {number|string|null} expireAt - 到期时间（Unix 秒时间戳或 ISO 字符串，null 表示永久）
 * @param {Object} logger - 日志工具
 */
function _setWindowExpireLabel(getMainWindow, expireAt, logger) {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;

    let label = '';
    const isPermanent = (expireAt === null || expireAt === undefined || expireAt === '' ||
                         expireAt === -1 || expireAt === '-1');
    if (!isPermanent) {
        // 兼容秒级（10位）或毫秒级（13位）时间戳
        const ms = String(expireAt).length <= 10 ? expireAt * 1000 : expireAt;
        const d = new Date(ms);
        if (!isNaN(d.getTime())) {
            label = ' | 授权到期: ' + d.toLocaleString('zh-CN', {
                year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
            });
        }
    } else {
        label = ' | 授权到期: 永久';
    }
    win.setTitle('Dreamina Toolkit' + label);
    logger.info('[Window] 标题已更新:' + 'Dreamina Toolkit' + label);
}

// ==================== IPC 处理器注册 ====================

/**
 * 软件启动强验证入口（登录页激活时调用）
 * @param {Function} logger - 外部注入的日志工具
 */
function registerLoginVerifyHandler(logger) {
    ipcMain.handle('login:verify', async (event, licenseKey) => {
        logger.info('[IPC] login:verify', licenseKey ? '***' + licenseKey.slice(-4) : 'empty');

        if (!licenseKey || typeof licenseKey !== 'string') {
            return { success: false, error: 'Invalid activation code format.' };
        }

        try {
            const { verifySoftwareLicense } = require('./cloud_auth');
            const res = await verifySoftwareLicense(licenseKey);

            if (res.success) {
                // 【核心拼图就位】：把云端下发的关键数据写入全局内存
                global.SOFTWARE_SECURE_PAYLOAD = res.payload;
                logger.info('[安全认证] 软件激活成功，内存凭证已注入。到期时间:', res.payload.expire_at);

                // 同时写入本地 license.json（保持向后兼容）
                const LICENSE_FILE_PATH = getLicenseFilePath();
                const licenseData = {
                    activated: true,
                    licenseKey: licenseKey,
                    activatedAt: new Date().toISOString(),
                    version: app.getVersion(),
                };
                fs.writeFileSync(LICENSE_FILE_PATH, JSON.stringify(licenseData, null, 2), 'utf-8');

                return { success: true };
            } else {
                logger.warn('[安全认证] 激活失败:', res.error);
                return { success: false, error: res.error };
            }
        } catch (e) {
            logger.error('[安全认证] 内部错误:', e.message);
            return { success: false, error: e.message };
        }
    });
}

/**
 * 激活成功后，切换到主应用页面
 * @param {Function} logger - 外部注入的日志工具
 * @param {Function} getMainWindow - 获取 mainWindow 实例的函数
 * @param {string} WEB_UI_DIR - Web UI 目录路径
 */
function registerActivationSuccessHandler(logger, getMainWindow, WEB_UI_DIR) {
    ipcMain.on('login:activation-success', (event) => {
        logger.info('[IPC] login:activation-success 切换到主界面');
        const mainWindow = getMainWindow();
        if (mainWindow) {
            mainWindow.loadFile(path.join(WEB_UI_DIR, 'index.html'))
                .then(() => {
                    // 从全局内存中读取 expire_at，设置窗口副标题
                    _setWindowExpireLabel(getMainWindow,
                        global.SOFTWARE_SECURE_PAYLOAD && global.SOFTWARE_SECURE_PAYLOAD.expire_at,
                        logger);
                })
                .catch(err => logger.error('加载主页面失败:', err.message));
        }
    });
}

// ==================== 核心流程：云端静默查岗 ====================

/**
 * 云端静默查岗（二次启动时从内存恢复凭证）
 * - 读取本地 licenseKey
 * - 向云端 verifySoftwareLicense 查岗
 * - 成功：注入 global.SOFTWARE_SECURE_PAYLOAD，加载主界面
 * - 失败：删除本地 license.json，清理内存，加载登录页并通知前端
 *
 * @param {Function} logger - 外部注入的日志工具
 * @param {Function} getMainWindow - 获取 mainWindow 实例的函数
 * @param {string} WEB_UI_DIR - Web UI 目录路径
 * @returns {Function} asyncSilentReverify 函数，可供外部调用
 */
function createAsyncSilentReverify(logger, getMainWindow, WEB_UI_DIR) {
    return async function asyncSilentReverify() {
        const localKey = readLocalLicenseKey(logger);
        if (!localKey) {
            // 本地无 license，直接留在登录页
            return;
        }

        logger.info('[安全认证] 检测到本地许可证，后台静默查岗...');

        // --- 新增：通知前端显示高级加载遮罩 ---
        const mainWindow = getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('login:silent-verify-start');
        }
        // ----------------------------------------

        try {
            const { verifySoftwareLicense } = require('./cloud_auth');
            const res = await verifySoftwareLicense(localKey);

            if (res.success) {
                // 查岗成功：注入内存凭证，直接跳转主界面
                global.SOFTWARE_SECURE_PAYLOAD = res.payload;
                logger.info('[安全认证] 云端查岗通过，内存凭证已注入。到期时间:', res.payload.expire_at);

                const mainWindow = getMainWindow();
                if (mainWindow) {
                    mainWindow.loadFile(path.join(WEB_UI_DIR, 'index.html'))
                        .then(() => {
                            // 设置窗口副标题（到期时间）
                            _setWindowExpireLabel(getMainWindow, res.payload.expire_at, logger);
                        })
                        .catch(err => logger.error('[安全认证] 加载主界面失败:', err.message));
                }
            } else {
                // 查岗失败：激活码被删/过期/设备不匹配
                logger.warn('[安全认证] 云端查岗失败:', res.error);
                deleteLocalLicense(logger);
                global.SOFTWARE_SECURE_PAYLOAD = null;

                // 通知渲染进程：授权已失效（登录页会展示提示）
                const mainWindow = getMainWindow();
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.loadFile(path.join(WEB_UI_DIR, 'login', 'index.html'))
                        .then(() => {
                            mainWindow.webContents.send('login:auth-invalid', res.error || '授权已失效，请重新激活');
                        })
                        .catch(err => logger.error('[安全认证] 加载登录页失败:', err.message));
                }
            }
        } catch (e) {
            // 网络异常等极端情况：留在登录页，不强断用户体验
            logger.error('[安全认证] 静默查岗异常:', e.message);
        }
    };
}

// ==================== 模块导出：初始化函数 ====================

/**
 * 【安全核心】实时检测授权是否已过期（防本地时间作弊）
 * 利用 global.TIME_OFFSET 将本地时间同步为服务器时间，再与到期时间对比
 *
 * @returns {boolean} true = 已过期，false = 未过期 / 永久授权
 */
function isLicenseExpired() {
    // 无内存凭证 = 未激活，等同过期
    if (!global.SOFTWARE_SECURE_PAYLOAD) return true;

    const expireAt = global.SOFTWARE_SECURE_PAYLOAD.expire_at;
    // 永久授权 (-1 / null / undefined / '') 不过期
    if (expireAt === null || expireAt === undefined || expireAt === '' || expireAt === -1 || expireAt === '-1') {
        return false;
    }

    // 获取服务器真实时间 = 本地时间 + 偏移量
    const serverNow = Date.now() + (global.TIME_OFFSET || 0);

    // expire_at 为秒时间戳时转毫秒
    const expireMs = String(expireAt).length <= 10 ? expireAt * 1000 : expireAt;
    return serverNow > expireMs;
}

/**
 * 初始化授权系统
 * @param {Object} opts
 * @param {Function} opts.getMainWindow - 返回当前 mainWindow 实例的函数
 * @param {string} opts.WEB_UI_DIR - Web UI 目录的绝对路径
 * @param {Object} opts.logger - 日志工具 { info, warn, error }
 * @returns {{ asyncSilentReverify: Function, isLicenseExpired: Function }}
 *          返回 asyncSilentReverify 函数和 isLicenseExpired 校验函数供 main.js 调用
 */
function initAuthSystem({ getMainWindow, WEB_UI_DIR, logger }) {
    // 注册所有 IPC 通道
    registerLoginVerifyHandler(logger);
    registerActivationSuccessHandler(logger, getMainWindow, WEB_UI_DIR);

    // 创建并返回静默查岗函数
    return {
        asyncSilentReverify: createAsyncSilentReverify(logger, getMainWindow, WEB_UI_DIR),
        isLicenseExpired: isLicenseExpired,
    };
}

module.exports = { initAuthSystem };

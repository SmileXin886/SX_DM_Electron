/**
 * 安全浏览器启动模块
 * 使用 Electron 原生 BrowserWindow，注入 Cookie、注入指纹、拦截退出
 * 全流程内存操作，用完即清零凭证
 */
const { BrowserWindow, session, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { getAccountManager } = require('./account_manager');

/**
 * 启动即梦AI安全浏览器窗口
 * @param {Object} credentials - decryptSxc 返回的凭证 { cookies, envFingerprint }
 * @param {string} accountId - 账号ID
 * @param {BrowserWindow} [mainWin] - 主窗口引用，用于头像下载完成后通知刷新
 * @returns {Promise<BrowserWindow>}
 */
async function startSecureBrowser(credentials, accountId, mainWin) {
    const env = credentials.envFingerprint || {};
    const cookies = credentials.cookies || [];

    // 纯内存 Session（无 persist: 前缀），窗口关闭即内存释放，无痕可查
    const sesLabel = `jimeng_${Date.now()}`;
    const ses = session.fromPartition(sesLabel, { cache: false });

    // 强制直连网络，绕过所有系统代理（防止 Fiddler/Charles/Proxifier 等抓包工具劫持流量）
    ses.setProxy({ proxyRules: 'direct://' });

    // 拦截退出登录请求，清本地 Cookie 后刷新页面，和扩展端保持一致
    let win = null; // 提前声明，供闭包访问
    ses.webRequest.onBeforeRequest(
        { urls: ['*://*.jianying.com/*logout*', '*://*.jianying.com/*signout*'] },
        (details, callback) => {
            // 1. 清空本地所有存储数据
            ses.clearStorageData();
            // 2. 刷新页面，让页面变成未登录状态
            if (win && !win.isDestroyed()) {
                win.webContents.reload();
            }
            // 3. 取消请求，绝对不让退出请求发到服务器，防止服务器端 Cookie 失效
            callback({ cancel: true });
        }
    );

    // 注入 Cookie
    for (const c of cookies) {
        try {
            const cleanDomain = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
            const targetUrl = `https://${cleanDomain}`;
            await ses.cookies.set({
                url: targetUrl,
                name: c.name,
                value: c.value,
                domain: c.domain,
                path: c.path || '/',
                secure: c.secure !== false,
                httpOnly: c.httpOnly === true,
                sameSite: c.sameSite || 'Lax',
                expirationDate: c.expirationDate || (Date.now() / 1000 + 86400 * 30),
            });
        } catch (e) {
            console.warn(`[BrowserLauncher] Cookie 注入失败: ${c.name}`, e.message);
        }
    }

    // 屏幕尺寸
    const screenRes = env.screenResolution || '1280x720';
    const [width, height] = screenRes.split('x').map(Number);

    // 创建窗口
    win = new BrowserWindow({
        width: parseInt(width) || 1280,
        height: parseInt(height) || 720,
        title: '即梦AI - Dreamina Toolkit',
        frame: true,
        backgroundColor: '#0f0f0f',
        webPreferences: {
            session: ses,
            nodeIntegration: false,
            contextIsolation: true,
            devTools: false,   // 彻底禁用开发者工具
            sandbox: false,
            preload: path.join(__dirname, '..', 'preload.js'),
            additionalArguments: [`--page-vars=${JSON.stringify(credentials.pageVariables || {})}`],
        },
    });

    // 禁用右键菜单和开发者工具快捷键，同时恢复 F5/Ctrl+R 刷新快捷键
    win.webContents.on('context-menu', e => e.preventDefault());
    win.webContents.on('before-input-event', (e, input) => {
        // 拦截开发者工具快捷键，防止用户抓包
        if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) {
            e.preventDefault();
            return;
        }
        // 手动处理刷新快捷键：因为我们禁用了应用菜单，默认的刷新快捷键失效了，这里手动恢复
        if (input.key === 'F5' || (input.control && input.key === 'r')) {
            win.webContents.reload();
            e.preventDefault();
            return;
        }
    });

    // 锁死新窗口：所有 window.open / target="_blank" 链接强制在当前安全窗口内加载
    win.webContents.setWindowOpenHandler(({ url }) => {
        win.loadURL(url);
        return { action: 'deny' };
    });

    // 吞掉 Electron 默认打印的加载错误日志（主页面本身是成功的，只是内部子导航/iframe 偶尔失败）
    win.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
        if (errorCode === -3 || errorCode === -2) return;
        console.warn(`[BrowserLauncher] 页面加载失败: ${errorDescription} (${errorCode}) - ${validatedURL}`);
    });
    win.webContents.on('render-process-gone', (event, details) => {
        if (details.reason === 'clean-exit' || details.reason === 'killed') return;
        console.warn(`[BrowserLauncher] 渲染进程异常退出: ${details.reason}`);
    });

    // 注入 UA
    if (env.userAgent) {
        win.webContents.userAgent = env.userAgent;
    }

    // 加载即梦
    await win.loadURL('https://jimeng.jianying.com/');

    // ==================== 核心：页面加载完后，自动拉取用户信息 ====================
    win.webContents.once('did-finish-load', async () => {
        try {
            console.log('[页面加载完成，开始从全局变量拿用户信息]');
            // 直接拿你window里已经有的__userInfo！你控制台已经显示它存在了！
            const userInfo = await win.webContents.executeJavaScript(`
                new Promise((resolve) => {
                    // 等页面初始化完成，最多等3秒
                    const check = () => {
                        if (window.__userInfo) {
                            const user = window.__userInfo;
                            console.log('找到用户信息了！', user);
                            return resolve({
                                nickname: user.nickname || user.name,
                                avatarUrl: user.avatar_url || user.avatar
                            });
                        }
                        setTimeout(check, 100);
                    };
                    check();
                })
            `);

            if (userInfo && userInfo.nickname && userInfo.avatarUrl) {
                const nickname = userInfo.nickname;
                const avatarUrl = userInfo.avatarUrl;

                console.log('[成功拿到用户信息]', nickname, avatarUrl);

                // 下载头像到缓存目录
                const am = getAccountManager();
                const avatarFilename = `${accountId}_avatar.png`;
                const avatarPath = path.join(am._cacheDir, avatarFilename);

                console.log('[下载头像到]', avatarPath);

                // 下载头像
                const downloadReq = net.request({
                    method: 'GET',
                    url: avatarUrl,
                    session: ses,
                    headers: {
                        'User-Agent': env.userAgent,
                        'Referer': 'https://jimeng.jianying.com/',
                    }
                });
                downloadReq.on('response', (res) => {
                    console.log('[头像下载响应]', res.statusCode);
                    const fileStream = fs.createWriteStream(avatarPath);
                    res.pipe(fileStream);
                    fileStream.on('finish', () => {
                        console.log('[头像下载完成！]');
                        // 更新账号信息
                        am.updateAccountUserInfo(accountId, nickname, avatarPath);
                    });
                });
                downloadReq.on('error', (err) => {
                    console.error('[头像下载失败]', err);
                });
                downloadReq.end();
            }
        } catch(e) {
            console.warn('[拉取用户信息失败，不影响使用]:', e);
        }
    });

    // 窗口关闭时清理 Session
    win.on('closed', () => {
        ses.clearStorageData();
    });

    // 内存清零（凭证仅在函数作用域内，后续不再引用）
    return win;
}

module.exports = { startSecureBrowser };

/**
 * 安全浏览器启动模块
 * 使用 Electron 原生 BrowserWindow，注入 Cookie、注入指纹、拦截退出
 * 全流程内存操作，用完即清零凭证
 *
 * 【架构】：统一网关 + 路由分发
 * 所有 webRequest.onBeforeRequest 监听器收敛至此，
 * 各子模块通过导出 handleCanvasRequest 函数由网关统一调用。
 */
const { BrowserWindow, session, net, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { getAccountManager } = require('./account_manager');
const { attachTracker, notifyProfileUpdate } = require('./points_tracker/index');

// 记录当前活跃的账号窗口
const activeWindows = new Map();

// 【终极安全补丁】用于在内存中安全中转风控变量，防止命令行明文泄露
const securePageVarsStore = new Map();

// 注册一次性的全局 IPC 处理器，供 preload.js 安全提取数据
if (!ipcMain.eventNames().includes('get-secure-page-vars')) {
    ipcMain.handle('get-secure-page-vars', (event) => {
        const webContentsId = event.sender.id;
        const vars = securePageVarsStore.get(webContentsId);
        securePageVarsStore.delete(webContentsId); // 阅后即焚，绝对不留痕迹
        return vars;
    });
}

async function startSecureBrowser(credentials, accountId, mainWin) {
    if (activeWindows.has(accountId)) {
        const existingWin = activeWindows.get(accountId);
        if (!existingWin.isDestroyed()) {
            if (existingWin.isMinimized()) existingWin.restore();
            existingWin.focus();
            return existingWin;
        } else {
            activeWindows.delete(accountId);
        }
    }
    const env = credentials.envFingerprint || {};
    const cookies = credentials.cookies || [];

    const sesLabel = `jimeng_${Date.now()}`;
    const ses = session.fromPartition(sesLabel, { cache: false });

    ses.setProxy({ proxyRules: 'direct://' });

    let win = null;

    const { setupCanvasBlocker } = require('./points_tracker/canvas_agent_blocker');

    let canvasBlocker = null;

    // ==========================================================
    // 【统一网关】所有 webRequest.onBeforeRequest 监听器收敛于此
    // URL 匹配规则合并，防止 Electron 单例覆盖导致监听器失效
    // 路由分发逻辑见 onBeforeRequest 回调内部
    // ==========================================================
    ses.webRequest.onBeforeRequest(
        {
            urls: [
                // 登出拦截
                '*://*.jianying.com/*logout*',
                '*://*.jianying.com/*signout*',
                // 画布 Agent 拦截
                '*://*.jianying.com/*/infinite_canvas/conversation*',
            ]
        },
        (details, callback) => {
            const url = details.url || '';

            // ---------- 路由 1：登出请求 ----------
            if (url.includes('/logout') || url.includes('/signout')) {
                ses.clearStorageData();
                if (win && !win.isDestroyed()) {
                    win.webContents.reload();
                }
                callback({ cancel: true });
                return;
            }

            // ---------- 路由 2：画布 Agent 请求 ----------
            if (url.includes('/infinite_canvas/conversation')) {
                if (canvasBlocker && typeof canvasBlocker.handleCanvasRequest === 'function') {
                    canvasBlocker.handleCanvasRequest(details, callback);
                } else {
                    callback({ cancel: false });
                }
                return;
            }

            // ---------- 默认：放行 ----------
            callback({ cancel: false });
        }
    );

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

    const screenRes = env.screenResolution || '1280x720';
    const [width, height] = screenRes.split('x').map(Number);

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
            devTools: false,
            sandbox: false,
            preload: path.join(__dirname, '..', 'preload.js')
            // 【移除】删除了危险的 additionalArguments 参数
        },
    });

    // 【终极安全补丁】将高危变量存入内存 Map，以 webContents.id 为钥匙
    securePageVarsStore.set(win.webContents.id, credentials.pageVariables || {});

    // 在 BrowserWindow 创建完毕后初始化画布拦截器（DOM 注入依赖 win 实例）
    canvasBlocker = setupCanvasBlocker(win);

    win.webContents.on('context-menu', e => e.preventDefault());
    win.webContents.on('before-input-event', (e, input) => {
        if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) {
            e.preventDefault();
            return;
        }
        if (input.key === 'F5' || (input.control && input.key === 'r')) {
            win.webContents.reload();
            e.preventDefault();
            return;
        }
    });

    win.webContents.setWindowOpenHandler(({ url }) => {
        win.loadURL(url);
        return { action: 'deny' };
    });

    win.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
        if (errorCode === -3 || errorCode === -2) return;
        console.warn(`[BrowserLauncher] 页面加载失败: ${errorDescription} (${errorCode}) - ${validatedURL}`);
    });
    win.webContents.on('render-process-gone', (event, details) => {
        if (details.reason === 'clean-exit' || details.reason === 'killed') return;
        console.warn(`[BrowserLauncher] 渲染进程异常退出: ${details.reason}`);
    });

    if (env.userAgent) {
        win.webContents.userAgent = env.userAgent;
    }

    win.webContents.once('did-finish-load', async () => {
        try {
            const userInfoStr = await win.webContents.executeJavaScript(`
                new Promise((resolve) => {
                    const script = document.createElement('script');
                    script.id = 'sx-user-info-extractor';
                    script.textContent = \`
                        (function() {
                            let user = null;
                            if (window.__userInfo) {
                                user = window.__userInfo;
                            } else if (window.__userInfoStringify) {
                                try { user = JSON.parse(window.__userInfoStringify); } catch(e){}
                            }
                            let data = null;
                            if (user) {
                                const innerUser = user.user_info || user;
                                const nickname = innerUser.nick_name || innerUser.nickname || innerUser.name || innerUser.user_name || '即梦用户';
                                let avatarUrl = '';
                                if (innerUser.avatar_urls) {
                                    avatarUrl = innerUser.avatar_urls.avatar_url_large || innerUser.avatar_urls.avatar_url_medium || innerUser.avatar_urls.avatar_url_small;
                                }
                                if (!avatarUrl) {
                                    avatarUrl = innerUser.avatar_url || innerUser.avatar || innerUser.avatarUrl;
                                }
                                data = {
                                    raw: user,
                                    nickname: nickname,
                                    avatarUrl: avatarUrl
                                };
                            }
                            const metaEl = document.createElement('meta');
                            metaEl.name = 'sx-extracted-user';
                            metaEl.content = data ? JSON.stringify(data) : '';
                            document.head.appendChild(metaEl);
                        })();
                    \`;
                    document.documentElement.appendChild(script);
                    script.remove();

                    let count = 0;
                    const check = () => {
                        count++;
                        if (count > 50) return resolve(null);
                        const meta = document.querySelector('meta[name="sx-extracted-user"]');
                        if (meta) {
                            const content = meta.content;
                            meta.remove();
                            return resolve(content);
                        }
                        setTimeout(check, 100);
                    };
                    check();
                })
            `);

            if (userInfoStr) {
                const userInfo = JSON.parse(userInfoStr);
                const nickname = userInfo.nickname || '即梦用户';
                let avatarUrl = userInfo.avatarUrl;

                if (avatarUrl && avatarUrl.startsWith('//')) {
                    avatarUrl = 'https:' + avatarUrl;
                }
                if (!avatarUrl) return;

                const am = getAccountManager();
                const avatarFilename = `${accountId}_avatar.png`;
                const avatarPath = path.join(am._cacheDir, avatarFilename);

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
                    if (res.statusCode >= 400) return;
                    const fileStream = fs.createWriteStream(avatarPath);
                    res.pipe(fileStream);
                    fileStream.on('finish', () => {
                        am.updateAccountUserInfo(accountId, nickname, avatarPath);
                        // 通知全局悬浮窗更新头像/昵称
                        notifyProfileUpdate(nickname, avatarPath);
                        if (mainWin && !mainWin.isDestroyed()) {
                            mainWin.webContents.send('jimeng:refreshList');
                        }
                    });
                });
                downloadReq.end();
            }
        } catch(e) {}
    });

    // 挂载积分追踪器（透明悬浮计分板 + CDP 静默抓包）
    const trackerHandle = attachTracker(win, accountId);

    await win.loadURL('https://jimeng.jianying.com/');

    activeWindows.set(accountId, win);

    win.on('closed', () => {
        if (canvasBlocker && typeof canvasBlocker.stop === 'function') {
            canvasBlocker.stop();
        }
        trackerHandle.destroy();
        ses.clearStorageData();
        activeWindows.delete(accountId);
        if (mainWin && !mainWin.isDestroyed()) {
            mainWin.webContents.send('jimeng:windowClosed', accountId);
        }
    });

    return win;
}

function getActiveAccountIds() {
    return Array.from(activeWindows.keys());
}

module.exports = { startSecureBrowser, getActiveAccountIds };

/**
 * 安全浏览器启动模块
 * 使用 Electron 原生 BrowserWindow，注入 Cookie、注入指纹、拦截退出
 * 全流程内存操作，用完即清零凭证
 */
const { BrowserWindow, session, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { getAccountManager } = require('./account_manager');

// 记录当前活跃的账号窗口，key=accountId，value=BrowserWindow
const activeWindows = new Map();

/**
 * 启动即梦AI安全浏览器窗口
 * @param {Object} credentials - decryptSxc 返回的凭证 { cookies, envFingerprint }
 * @param {string} accountId - 账号ID
 * @param {BrowserWindow} [mainWin] - 主窗口引用，用于头像下载完成后通知刷新
 * @returns {Promise<BrowserWindow>}
 */
async function startSecureBrowser(credentials, accountId, mainWin) {
    // 【防双开】：如果这个账号的窗口已经存在，将其聚焦并直接返回
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

    // ==================== 【终极修复！】先绑定事件，再加载页面！ ====================
    win.webContents.once('did-finish-load', async () => {
        try {
            console.log('[页面加载完成，开始突破沙盒获取用户信息]');

            // 核心黑魔法：通过动态注入 <script> 标签，将主世界的变量抛出，
            // 并把结果写入 document.title 或某个隐藏的 DOM 节点，再由外部读取。
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
                                // 兼容多层嵌套结构：有些页面的 user 就是外层，有些被包在 user_info 里
                                const innerUser = user.user_info || user;

                                // 提取昵称 (支持 nick_name, nickname, name 等多种可能)
                                const nickname = innerUser.nick_name || innerUser.nickname || innerUser.name || innerUser.user_name || '即梦用户';

                                // 提取头像 (优先拿 avatar_urls 里的头像，拿不到再去拿外层)
                                let avatarUrl = '';
                                if (innerUser.avatar_urls) {
                                    avatarUrl = innerUser.avatar_urls.avatar_url_large || innerUser.avatar_urls.avatar_url_medium || innerUser.avatar_urls.avatar_url_small;
                                }
                                if (!avatarUrl) {
                                    avatarUrl = innerUser.avatar_url || innerUser.avatar || innerUser.avatarUrl;
                                }

                                data = {
                                    raw: user, // 保留 raw 方便以后排查
                                    nickname: nickname,
                                    avatarUrl: avatarUrl
                                };
                            }

                            // 把拿到的数据塞进 DOM 元素的属性里，供外部读取
                            const metaEl = document.createElement('meta');
                            metaEl.name = 'sx-extracted-user';
                            metaEl.content = data ? JSON.stringify(data) : '';
                            document.head.appendChild(metaEl);
                        })();
                    \`;
                    document.documentElement.appendChild(script);
                    script.remove(); // 阅后即焚

                    // 轮询检查 meta 标签是否生成
                    let count = 0;
                    const check = () => {
                        count++;
                        if (count > 50) return resolve(null); // 最多等 5 秒

                        const meta = document.querySelector('meta[name="sx-extracted-user"]');
                        if (meta) {
                            const content = meta.content;
                            meta.remove(); // 阅后即焚
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

                // 【必须保留】：字节系的头像 URL 经常是 "//p3-pc..."，强行补全 https:
                if (avatarUrl && avatarUrl.startsWith('//')) {
                    avatarUrl = 'https:' + avatarUrl;
                }

                if (!avatarUrl) {
                    // 【修改】：打印出它到底抓到了什么神仙数据！
                    console.log('[解析到了用户信息，但没有头像 URL]。完整的用户数据是：\n', JSON.stringify(userInfo.raw, null, 2));
                    return;
                }

                console.log('[突破沙盒成功！拿到用户信息]', nickname, avatarUrl);

                const am = getAccountManager();
                const avatarFilename = `${accountId}_avatar.png`;
                const avatarPath = path.join(am._cacheDir, avatarFilename);
                console.log('[下载头像到]', avatarPath);

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
                    console.log('[头像下载响应状态码]', res.statusCode);
                    if (res.statusCode >= 400) {
                        console.error('[头像下载失败]');
                        return;
                    }
                    const fileStream = fs.createWriteStream(avatarPath);
                    res.pipe(fileStream);
                    fileStream.on('finish', () => {
                        console.log('[头像下载并且写入本地完成！]');
                        am.updateAccountUserInfo(accountId, nickname, avatarPath);
                        if (mainWin && !mainWin.isDestroyed()) {
                            mainWin.webContents.send('jimeng:refreshList');
                        }
                    });
                });
                downloadReq.on('error', (err) => {
                    console.error('[头像下载请求失败]', err);
                });
                downloadReq.end();
            } else {
                console.warn('[未能从主世界提取到用户信息]');
            }
        } catch(e) {
            console.warn('[执行注入脚本失败]:', e);
        }
    });

    // ==================== 最后才加载页面！ ====================
    await win.loadURL('https://jimeng.jianying.com/');

    // 将新创建的窗口存入活跃列表
    activeWindows.set(accountId, win);

    // 窗口关闭时清理 Session 和活跃记录
    win.on('closed', () => {
        ses.clearStorageData();
        activeWindows.delete(accountId);
        if (mainWin && !mainWin.isDestroyed()) {
            mainWin.webContents.send('jimeng:windowClosed', accountId);
        }
    });

    // 内存清零（凭证仅在函数作用域内，后续不再引用）
    return win;
}

function getActiveAccountIds() {
    return Array.from(activeWindows.keys());
}

module.exports = { startSecureBrowser, getActiveAccountIds };

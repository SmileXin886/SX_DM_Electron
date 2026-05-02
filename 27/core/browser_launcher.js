/**
 * 安全浏览器启动模块
 * 使用 Electron 原生 BrowserWindow，注入 Cookie、注入指纹、拦截退出
 * 全流程内存操作，用完即清零凭证
 */
const { BrowserWindow, session } = require('electron');
const path = require('path');

/**
 * 启动即梦AI安全浏览器窗口
 * @param {Object} credentials - decryptSxc 返回的凭证 { cookies, envFingerprint }
 * @returns {Promise<BrowserWindow>}
 */
async function startSecureBrowser(credentials) {
    const env = credentials.envFingerprint || {};
    const cookies = credentials.cookies || [];

    // 纯内存 Session（无 persist: 前缀），窗口关闭即内存释放，无痕可查
    const sesLabel = `jimeng_${Date.now()}`;
    const ses = session.fromPartition(sesLabel, { cache: false });

    // 强制直连网络，绕过所有系统代理（防止 Fiddler/Charles/Proxifier 等抓包工具劫持流量）
    ses.setProxy({ proxyRules: 'direct://' });

    // 提前声明 win 变量，给后面的拦截闭包用
    let win = null;

    // 拦截退出登录请求，清本地 Cookie 后刷新页面，和扩展端保持一致
    ses.webRequest.onBeforeRequest(
        { urls: ['*://*.jianying.com/*logout*', '*://*.jianying.com/*signout*'] },
        (details, callback) => {
            // 1. 清空本地所有存储数据
            ses.clearStorageData();
            // 2. 刷新页面，让页面变成未登录状态
            if (win && !win.isDestroyed()) {
                win.webContents.reload();
            }
            // 3. 取消请求，绝对不让退出请求发到服务器
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

    // 注入 UA
    if (env.userAgent) {
        win.webContents.userAgent = env.userAgent;
    }

    // 加载即梦
    await win.loadURL('https://jimeng.jianying.com/');

    // 窗口关闭时清理 Session
    win.on('closed', () => {
        ses.clearStorageData();
    });

    // 内存清零（凭证仅在函数作用域内，后续不再引用）
    return win;
}

module.exports = { startSecureBrowser };

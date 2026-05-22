/**
 * canvas_agent_blocker.js - 画布模式 Agent 请求精准拦截模块
 * =========================================================
 * 改造为【纯逻辑模块】：只保留 DOM 注入 + 物理拆包拦截的判断逻辑。
 * 不再自行绑定 webRequest 监听器，由 browser_launcher.js 统一网关调用。
 *
 * 【多实例工厂模式】：每个 BrowserWindow 创建独立的闭包作用域
 */

const logger = {
    info: (...a) => console.log('[CanvasBlocker]', new Date().toLocaleTimeString('zh-CN', { hour12: false }), ...a),
    warn: (...a) => console.warn('[CanvasBlocker]', ...a),
    error: (...a) => console.error('[CanvasBlocker]', ...a),
};

const TARGET_CONVERSATION_API = '/infinite_canvas/conversation';
const HOMEPAGE_AGENT_FLAG = 'enter_from=canvas_homepage_agent';

/**
 * 画布拦截器工厂函数
 * 为每个 BrowserWindow 创建独立的闭包作用域
 * @param {BrowserWindow} win - 即梦安全浏览器窗口
 * @returns {{
 *   stop: () => void,
 *   handleCanvasRequest: (details: object, callback: function) => void
 * }}
 */
function setupCanvasBlocker(win) {
    let _isAttached = false;

    function getInjectionScript() {
        return `
            (function() {
                const INJECT_FLAG = Symbol.for('sx_canvas_block');
                if (window[INJECT_FLAG]) return;
                window[INJECT_FLAG] = true;

                const targetApi = '${TARGET_CONVERSATION_API}';
                const redirectFlag = '${HOMEPAGE_AGENT_FLAG}';

                window.showCanvasBlockAlert = function() {
                    if (document.getElementById('sx-canvas-alert')) return;

                    const overlay = document.createElement('div');
                    overlay.id = 'sx-canvas-alert';
                    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.4);z-index:999999;display:flex;justify-content:center;align-items:center;backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);';

                    const box = document.createElement('div');
                    box.style.cssText = 'background:rgba(35, 35, 38, 0.7);color:#fff;padding:40px 32px;border-radius:16px;box-shadow:0 20px 40px rgba(0,0,0,0.4);font-family:system-ui,-apple-system,sans-serif;max-width:400px;text-align:center;border:1px solid rgba(255,255,255,0.1);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);';

                    const icon = document.createElement('div');
                    icon.innerHTML = '⚠️';
                    icon.style.cssText = 'font-size:64px;margin-bottom:20px;filter:drop-shadow(0 4px 8px rgba(0,0,0,0.2));';

                    const text = document.createElement('div');
                    text.innerHTML = '暂不支持画布内使用Agent模式<br>请切换生成对话模式下使用该模式';
                    text.style.cssText = 'font-size:16px;line-height:1.6;margin-bottom:32px;color:#FFFFFF;font-weight:500;letter-spacing:0.5px;text-shadow:0 1px 2px rgba(0,0,0,0.5);';

                    const btn = document.createElement('button');
                    btn.innerText = '我知道了';
                    btn.style.cssText = 'background:#10b981;color:#fff;border:none;padding:12px 40px;border-radius:8px;font-size:16px;cursor:pointer;font-weight:bold;box-shadow:0 4px 12px rgba(16, 185, 129, 0.3);transition:opacity 0.2s;';

                    btn.onmouseover = () => btn.style.opacity = '0.85';
                    btn.onmouseout = () => btn.style.opacity = '1';
                    btn.onclick = () => overlay.remove();

                    box.append(icon, text, btn);
                    overlay.appendChild(box);
                    document.body.appendChild(overlay);
                };

                // ==============================================
                // 【瞬间 DOM 探测】：用于首页跳转前判断
                // ==============================================
                function isAgentModeActive() {
                    try {
                        const xpath = "//*[text()='Agent 模式' or contains(text(), 'Agent 模式')]";
                        const iterator = document.evaluate(xpath, document, null, XPathResult.UNORDERED_NODE_ITERATOR_TYPE, null);
                        let node = iterator.iterateNext();
                        while (node) {
                            if (node.tagName !== 'TEXTAREA' && node.tagName !== 'INPUT' && !node.isContentEditable) {
                                const rect = node.getBoundingClientRect();
                                const style = window.getComputedStyle(node);
                                if (rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none') {
                                    return true;
                                }
                            }
                            node = iterator.iterateNext();
                        }
                        return false;
                    } catch (e) {
                        return false;
                    }
                }

                // ==============================================
                // 【核心防线】：放弃正则，改用最稳定的 includes
                // ==============================================
                function shouldBlockConversationApi() {
                    // 1. 画布内判断：只要 URL 包含 /canvas/，不管什么位置，无脑按死！
                    if (window.location.href.includes('/canvas/')) {
                        return true;
                    }
                    // 2. 首页判断：UI 选了 Agent 模式，拦！
                    if (isAgentModeActive()) {
                        return true;
                    }
                    return false;
                }

                const originalWindowOpen = window.open;
                window.open = function(url, target, features) {
                    if (url && String(url).includes(redirectFlag) && isAgentModeActive()) {
                        window.showCanvasBlockAlert && window.showCanvasBlockAlert();
                        return null;
                    }
                    return originalWindowOpen.call(this, url, target, features);
                };

                const originalPushState = window.history.pushState;
                window.history.pushState = function(state, unused, url) {
                    if (url && String(url).includes(redirectFlag) && isAgentModeActive()) {
                        window.showCanvasBlockAlert && window.showCanvasBlockAlert();
                        return;
                    }
                    return originalPushState.apply(this, arguments);
                };

                const originalReplaceState = window.history.replaceState;
                window.history.replaceState = function(state, unused, url) {
                    if (url && String(url).includes(redirectFlag) && isAgentModeActive()) {
                        window.showCanvasBlockAlert && window.showCanvasBlockAlert();
                        return;
                    }
                    return originalReplaceState.apply(this, arguments);
                };

                const originalFetch = window.fetch;
                window.fetch = new Proxy(originalFetch, {
                    apply: function(target, thisArg, args) {
                        const url = (typeof args[0] === 'string' ? args[0] : args[0]?.url || '').toLowerCase();
                        if (url.includes(targetApi) && shouldBlockConversationApi()) {
                            window.showCanvasBlockAlert && window.showCanvasBlockAlert();
                            const fakeBody = JSON.stringify({ code: 10001, status_code: 10001, message: "暂不支持", msg: "error", data: {} });
                            return Promise.resolve(new Response(fakeBody, { status: 200, statusText: "OK", headers: new Headers({ 'Content-Type': 'application/json' }) }));
                        }
                        return Reflect.apply(target, thisArg, args);
                    }
                });

                const originalXHROpen = window.XMLHttpRequest.prototype.open;
                const originalXHRSend = window.XMLHttpRequest.prototype.send;
                window.XMLHttpRequest.prototype.open = function(method, url, ...rest) {
                    this._sx_url = String(url).toLowerCase();
                    return originalXHROpen.call(this, method, url, ...rest);
                };
                window.XMLHttpRequest.prototype.send = function(...args) {
                    const url = this._sx_url || '';
                    if (url.includes(targetApi) && shouldBlockConversationApi()) {
                        window.showCanvasBlockAlert && window.showCanvasBlockAlert();
                        Object.defineProperty(this, 'readyState', { value: 4, writable: false });
                        Object.defineProperty(this, 'status', { value: 200, writable: false });
                        Object.defineProperty(this, 'responseText', { value: '{"code":10001}', writable: false });
                        if (typeof this.onload === 'function') this.onload();
                        if (typeof this.onreadystatechange === 'function') this.onreadystatechange();
                        return;
                    }
                    return originalXHRSend.apply(this, args);
                };
            })();
        `;
    }

    // 【多重生命周期绑定，极速注入，绝不给前端缓存 fetch 的机会！】
    function inject() {
        if (!win || win.isDestroyed()) return;
        win.webContents.executeJavaScript(getInjectionScript()).catch(() => {});
    }

    // 绑定 DOM 注入事件
    win.webContents.on('dom-ready', inject);
    win.webContents.on('did-navigate-in-page', inject);
    win.webContents.on('did-finish-load', inject);
    inject(); // 立即执行一次

    _isAttached = true;
    logger.info('画布Agent拦截已启动（winId=' + win.id + '）：DOM 注入已部署，等待统一网关路由分发');

    // ==============================================
    // 【统一网关路由处理器 - handleCanvasRequest】
    // 由 browser_launcher.js 的统一网关回调调用（检测到 /infinite_canvas/conversation 时）
    // 执行物理层拆包安检（抓 DOM 注入漏网的画布请求）
    // ==============================================
    function handleCanvasRequest(details, callback) {
        if (!win || win.isDestroyed()) return callback({ cancel: false });

        let isAgentLeak = false;

        // 直接在主进程、网卡级别读取 POST 请求的数据体
        try {
            if (details.uploadData && details.uploadData.length > 0 && details.uploadData[0].bytes) {
                const bodyStr = details.uploadData[0].bytes.toString('utf8');
                const bodyObj = JSON.parse(bodyStr);

                // 核心判据：只要 Body 里带有 metrics_extra，必定是 Agent 发的消息！视频生成绝对没有这个。
                const metricsStr = bodyObj?.messages?.[0]?.metadata?.metrics_extra;
                if (metricsStr) {
                    isAgentLeak = true;
                }
            }
        } catch(e) {
            // 解析失败（比如不是标准JSON），默认放行，防误杀
        }

        if (isAgentLeak) {
            logger.error(`[底层物理拦截] 抓到一条试图逃跑的 Agent 消息！已在系统层暴力掐断: ${details.url}`);
            win.webContents.executeJavaScript(`window.showCanvasBlockAlert && window.showCanvasBlockAlert();`).catch(()=>{});
            return callback({ cancel: true }); // 彻底物理断网
        }

        callback({ cancel: false });
    }

    return {
        stop: () => {
            _isAttached = false;
            logger.info('画布拦截器已停止 (winId=' + win.id + ')');
        },
        handleCanvasRequest,
    };
}

module.exports = { setupCanvasBlocker };

// 文件路径：core/points_tracker/heartbeat.js
const { ipcMain } = require('electron');

const instances = new Map();

// 全局监听保持在最外层，且只注册一次！
ipcMain.on('tracker:toggle-global', (event, { winId, state }) => {
    const hb = instances.get(winId);
    if (hb) {
        if (state) hb.start();
        else hb.stop();
    }
});

class Heartbeat {
    constructor(win) {
        this.win = win;
        this.interval = null;
        this.reqTemplate = null;
        instances.set(win.id, this);
    }

    updateTemplate(url, postData, headers) {
        const safeHeaders = {};
        for (const [k, v] of Object.entries(headers || {})) {
            const lower = k.toLowerCase();
            if (!lower.startsWith(':') && !['content-length', 'host', 'origin', 'referer', 'accept-encoding', 'connection'].includes(lower)) {
                safeHeaders[k] = v;
            }
        }
        this.reqTemplate = { url, postData, headers: safeHeaders };
    }

    start() {
        if (this.interval) return;

        // 【吸收精髓：自动引子】如果没有模板，用"幽灵手"自动点一次积分按钮偷模板
        if (!this.reqTemplate && !this.win.isDestroyed()) {
            this.win.webContents.executeJavaScript(`
                (function() {
                    const creditBtn = document.querySelector('.user-info__credit, [class*="credit"], [class*="points"]');
                    if (creditBtn) {
                        creditBtn.click();
                        // 1秒后自动把弹窗关掉，做到无痕
                        setTimeout(() => {
                            const closeBtn = document.querySelector('.modal__close, [class*="close"]');
                            if (closeBtn) closeBtn.click();
                        }, 1000);
                    }
                })();
            `).catch(()=>{});
        }

        this.interval = setInterval(() => {
            if (this.win.isDestroyed() || !this.reqTemplate) return;

            const fetchScript = `
                fetch('${this.reqTemplate.url}', {
                    method: 'POST',
                    headers: ${JSON.stringify(this.reqTemplate.headers)},
                    body: JSON.stringify({ page: 1, page_size: 20 }),
                    credentials: 'include'
                }).catch(()=>{});
            `;
            this.win.webContents.executeJavaScript(fetchScript).catch(()=>{});
        }, 10000); // 【吸收精髓】：改为更安全的 10 秒
    }

    stop() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
    }

    destroy() {
        this.stop();
        instances.delete(this.win.id);
    }
}

module.exports = Heartbeat;

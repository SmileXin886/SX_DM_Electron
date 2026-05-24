/**
 * ui_profile.js - 悬浮窗账号头像/昵称组件
 * =======================================
 * 职责：
 * - 在指定容器内渲染头像（圆形）+ 昵称
 * - 默认状态：深色半透明 SVG 占位符 + "加载中..."
 * - 监听 window.electron.onProfileUpdate，收到真实数据后平滑替换
 *
 * 注意：本组件不再从 URL hash 解析 accountId，完全依赖 IPC 事件驱动
 * 账号切换时，backend 会主动推送 tracker:update-profile 事件
 */
const DEFAULT_AVATAR_SVG = `<svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="16" cy="16" r="16" fill="rgba(255,255,255,0.05)"/>
    <path d="M16 16C18.2 16 20 14.2 20 12C20 9.8 18.2 8 16 8C13.8 8 12 9.8 12 12C12 14.2 13.8 16 16 16ZM16 18C13.3 18 8 19.3 8 22V24H24V22C24 19.3 18.7 18 16 18Z" fill="rgba(255,255,255,0.2)"/>
</svg>`;

class ProfileWidget {
    /**
     * @param {string} containerId - 要挂载的 DOM 容器 ID
     */
    constructor(containerId) {
        this._container = document.getElementById(containerId);
        if (!this._container) {
            console.warn('[ProfileWidget] 容器不存在:', containerId);
            return;
        }

        this._nickname = null;
        this._avatarPath = null;
        this._imgEl = null;
        this._nameEl = null;
        this._avatarWrap = null;

        this._render();
        this._bindIPC();
    }

    /** 渲染默认占位符 UI */
    _render() {
        this._container.innerHTML = `
            <div class="profile-widget-inner">
                <div class="profile-avatar" id="profile-avatar-wrap">
                    ${DEFAULT_AVATAR_SVG}
                </div>
                <span class="profile-name" id="profile-name-text">加载中...</span>
            </div>
        `;

        this._avatarWrap = this._container.querySelector('#profile-avatar-wrap');
        this._nameEl = this._container.querySelector('#profile-name-text');
    }

    /** 注入补足样式（仅注入 tracker.css 未覆盖的过渡效果） */
    _injectStyles() {
        if (document.getElementById('profile-widget-styles')) return;
        const style = document.createElement('style');
        style.id = 'profile-widget-styles';
        style.textContent = `
            .profile-avatar svg,
            .profile-avatar img {
                transition: opacity 0.3s ease;
            }
        `;
        document.head.appendChild(style);
    }

    /** 绑定 IPC 监听：等待 window.electron 就绪后订阅头像/昵称更新 */
    _bindIPC() {
        if (typeof window.electron === 'undefined') {
            console.warn('[ProfileWidget] window.electron 未定义，跳过 IPC 绑定');
            return;
        }

        window.electron.on('tracker:update-profile', (data) => {
            this.update(data.nickname, data.avatarPath);
        });
    }

    /**
     * 更新头像和昵称
     * @param {string|null} nickname
     * @param {string|null} avatarPath - 绝对路径或 null
     */
    update(nickname, avatarPath) {
        if (!this._container) return;

        this._nickname = nickname || this._nickname || '即梦用户';
        this._avatarPath = avatarPath;

        if (this._nameEl) {
            this._nameEl.textContent = this._nickname;
        }

        if (avatarPath) {
            this._injectStyles();

            if (!this._imgEl) {
                this._imgEl = document.createElement('img');
                this._imgEl.alt = 'avatar';
                this._imgEl.onerror = () => {
                    if (this._imgEl) {
                        this._imgEl.style.display = 'none';
                    }
                    this._renderFallback();
                };
            }

            this._imgEl.src = `file://${avatarPath}`;
            this._avatarWrap.innerHTML = '';
            this._avatarWrap.appendChild(this._imgEl);
        } else {
            this._renderFallback();
        }
    }

    /** 渲染 SVG 占位符兜底 */
    _renderFallback() {
        if (!this._avatarWrap) return;
        this._avatarWrap.innerHTML = DEFAULT_AVATAR_SVG;
    }

    /** 销毁时清理 */
    destroy() {
        this._container = null;
        this._imgEl = null;
        this._nameEl = null;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ProfileWidget };
}

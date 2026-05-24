/**
 * 资产管理页面 - 独立 JS 模块
 * 负责选项卡切换、内容动态渲染
 */
window.JimengAssets = {

    _currentType: 'video', // 当前激活的选项卡类型
    _initialized: false,

    init() {
        if (this._initialized) return;
        this._initialized = true;
        this._bindTabSwitch();
        this._renderContent(this._currentType);
    },

    /**
     * 绑定选项卡点击切换
     */
    _bindTabSwitch() {
        const buttons = document.querySelectorAll('.jm-assets-type-btn');
        buttons.forEach(btn => {
            btn.addEventListener('click', () => {
                const type = btn.dataset.type;
                if (type === this._currentType) return;

                buttons.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');

                this._currentType = type;
                this._renderContent(type);
            });
        });
    },

    /**
     * 根据类型渲染内容区域
     */
    _renderContent(type) {
        const contentEl = document.getElementById('jm-assets-content');
        if (!contentEl) return;

        const placeholders = {
            video: {
                icon: `<svg viewBox="0 0 24 24"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>`,
                text: '暂无视频作品'
            },
            image: {
                icon: `<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`,
                text: '暂无图片作品'
            },
            audio: {
                icon: `<svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`,
                text: '暂无音频作品'
            }
        };

        const p = placeholders[type] || placeholders.video;
        contentEl.innerHTML = `
            <div class="jm-assets-placeholder">
                ${p.icon}
                <span>${p.text}</span>
            </div>
        `;
    },

    /**
     * 对外暴露：切换到指定类型（供外部调用）
     */
    show() {
        if (!this._initialized) this.init();
    },

    destroy() {
        this._initialized = false;
        this._currentType = 'generations';
    },
};

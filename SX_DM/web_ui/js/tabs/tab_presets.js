/**
 * 预设管理模块 (tab_presets.js)
 * ==============================
 * 负责 page-presets 的所有 UI 交互和状态同步
 *
 * 【Electron 迁移说明】
 * - 旧版：API.call('get_presets', {}) → bridge → signal_result → EventBus
 * - 新版：API.getPresets() → fetch GET /api/presets → 直接更新
 * - 预设 CRUD 全部改为直接调用 API 方法（async/await）
 */

/**
 * 渲染预设列表到 DOM
 */
function renderPresets(presets) {
    const list = document.getElementById('presetsList');
    if (!list) return;

    if (!presets || presets.length === 0) {
        list.innerHTML = `
            <div style="text-align: center; padding: 40px 20px; color: #6e7681;">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="opacity: 0.5; margin-bottom: 16px;">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                </svg>
                <p>暂无预设</p>
                <p style="font-size: 12px; margin-top: 8px;">点击上方按钮创建新预设</p>
            </div>
        `;
        return;
    }

    list.innerHTML = presets.map(p => `
        <div class="preset-card" data-id="${p.id}">
            <div class="preset-name">${p.name}</div>
            <div class="preset-meta">${p.settings?.type || '通用'} · ${p.created || '未知时间'}</div>
            <div class="preset-actions">
                <button class="action-btn primary apply-preset-btn" data-id="${p.id}">应用</button>
                <button class="action-btn danger delete-preset-btn" data-id="${p.id}">删除</button>
            </div>
        </div>
    `).join('');
}

/**
 * 加载预设列表
 */
async function loadPresets() {
    try {
        const presets = await window.API.getPresets();
        AppState.setPresets(presets);
        renderPresets(presets);
    } catch (e) {
        console.error('[TabPresets] 加载预设失败:', e);
    }
}

/**
 * 初始化预设管理模块（由 app.js 的 onBridgeReady 触发）
 */
function initPresets() {
    // 绑定新建预设按钮
    const createBtn = document.querySelector('[data-action="create-preset"]');
    if (createBtn) {
        createBtn.addEventListener('click', createPreset);
    }

    // 预设列表区域（事件委托）
    const list = document.getElementById('presetsList');
    if (list) {
        list.addEventListener('click', (e) => {
            const applyBtn = e.target.closest('.apply-preset-btn');
            if (applyBtn) {
                applyPreset(applyBtn.dataset.id);
                return;
            }
            const deleteBtn = e.target.closest('.delete-preset-btn');
            if (deleteBtn) {
                deletePreset(deleteBtn.dataset.id);
                return;
            }
        });
    }

    // 订阅 EventBus 事件
    EventBus.on('preset:created', async (result) => {
        console.log('[TabPresets] 收到 preset:created', result);
        if (result.success) {
            window.showToast('预设创建成功');
            await loadPresets();
        } else {
            window.showToast('预设创建失败: ' + (result.error || ''));
        }
    });

    EventBus.on('preset:applied', (result) => {
        console.log('[TabPresets] 收到 preset:applied', result);
        if (result.success && result.preset) {
            window.showToast('已应用预设: ' + result.preset.name);
            const editor = document.getElementById('dreaminaPrompt');
            if (result.preset.textContent && editor) {
                editor.textContent = result.preset.textContent;
                if (window.TabTasks && window.TabTasks._state) {
                    window.TabTasks._state.prompt = result.preset.textContent;
                }
            }
        } else {
            window.showToast('应用预设失败');
        }
    });

    EventBus.on('preset:deleted', async (result) => {
        console.log('[TabPresets] 收到 preset:deleted', result);
        if (result.success) {
            window.showToast('预设已删除');
            await loadPresets();
        } else {
            window.showToast('删除预设失败');
        }
    });

    EventBus.on('presets:updated', async () => {
        await loadPresets();
    });

    console.log('[tab_presets.js] 模块初始化完成');
}

/**
 * 创建新预设
 */
async function createPreset() {
    const name = prompt('请输入预设名称：');
    if (name && name.trim()) {
        const config = {
            name: name.trim(),
            prompt: (window.TabTasks && window.TabTasks._state) ? window.TabTasks._state.prompt : '',
            settings: {
                type: (window.TabTasks && window.TabTasks._state) ? window.TabTasks._state.type : 'AI Video',
                model: (window.TabTasks && window.TabTasks._state) ? window.TabTasks._state.model : 'Dreamina Seedance 2.0 Fast',
                mode: (window.TabTasks && window.TabTasks._state) ? window.TabTasks._state.mode : 'first-last',
                aspect: (window.TabTasks && window.TabTasks._state) ? window.TabTasks._state.aspect : '16:9',
                duration: (window.TabTasks && window.TabTasks._state) ? window.TabTasks._state.duration : '10s',
                intensity: (window.TabTasks && window.TabTasks._state) ? window.TabTasks._state.intensity : 70
            }
        };
        await window.API.createPreset(config);
    }
}

/**
 * 应用预设
 */
async function applyPreset(id) {
    await window.API.applyPreset(id);
}

/**
 * 删除预设
 */
async function deletePreset(id) {
    if (confirm('确定要删除此预设吗？')) {
        await window.API.deletePreset(id);
    }
}

// 挂载到 window（供外部调用）
window.initPresets = initPresets;
window.renderPresets = renderPresets;

// 自动初始化（在 Bridge 就绪后触发，由 app.js 调用）
// 不在这里立即调用，因为此时 EventBus/httpClient 可能还未就绪
// 由 app.js 的 onBridgeReady 统一调用

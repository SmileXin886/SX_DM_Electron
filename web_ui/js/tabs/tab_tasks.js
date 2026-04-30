/**
 * 任务控制台模块 (tab_tasks.js)
 * ==============================
 * 负责 page-dreamina 的所有 UI 交互和状态同步
 *
 * 【Electron 迁移说明】
 * - window.pyBridge.open_file_dialog()  →  window.API.openAndProcessFiles()
 * - window.pyBridge.on_editor_drop()    →  window.API.processEditorDropFiles()
 * - window.pyBridge.request_native_preview() → 本地浏览器查看器 TabTasks.openViewer()
 * - window.pyBridge.remove_file()      →  window.API.removeFile()
 * - API.call('generate_task', ...)     →  window.wsClient.send({ type: 'GENERATE_TASK', ... })
 *
 * 【数据流】
 * 前端发起请求 → API.js (HTTP/Fetch) → FastAPI 后端
 * 后端推送 → WebSocket → api.js (EventBus) → TabTasks (更新 UI)
 */

const TabTasks = {
    _initialized: false,

    _state: {
        type: 'AI Video',
        model: 'Dreamina Seedance 2.0 Fast',
        mode: 'first-last',
        omniMode: 'omni',
        aspect: '16:9',
        resolution: '720P',
        duration: '10s',
        intensity: 70,
        prompt: ''
    },

    _mentionState: {
        active: false,
        searchText: '',
        startOffset: 0,
        selectedIndex: 0,
        items: []
    },

    // 防抖定时器
    _renderTimer: null,

    MAX_IMAGES: 12,
    MAX_VIDEOS: 3,
    MAX_AUDIOS: 3,
    MAX_TOTAL: 12,
    MAX_VIDEO_DURATION: 15.1,
    MAX_AUDIO_DURATION: 15,

    STACK_ANGLES: ['-rotate-12', 'rotate-12', '-rotate-8', 'rotate-8', '-rotate-4', 'rotate-4'],

    init: function() {
        if (this._initialized) return;
        this._initialized = true;

        this._bindEvents();
        this._subscribeEvents();
        this._syncStateToAppState();

        // 初始化首尾帧上传器
        this._initFrameUploader();

        // 根据初始模式设置比例选择器状态和首尾帧上传器显示状态
        this._updateRatioSelectorState();

        console.log('[tab_tasks.js] 模块初始化完成');
    },

    // 初始化首尾帧上传器
    _initFrameUploader: function() {
        const container = document.getElementById('frame-uploader-container');
        if (container && window.FrameUploader) {
            this._frameUploader = new window.FrameUploader('frame-uploader-container');
        }
    },

    _syncStateToAppState: function() {
        Object.keys(this._state).forEach(key => {
            if (AppState.hasOwnProperty(key)) {
                AppState[key] = this._state[key];
            }
        });
    },

    _loadFiles: async function() {
        try {
            const files = await window.API.getFiles();
            AppState.setUploadedFiles(files);
            this._scheduleRender();
        } catch (e) {
            console.warn('[TabTasks] 加载文件列表失败:', e);
        }
    },

    /**
     * 防抖渲染 - 避免快速连续操作导致多次渲染
     */
    _scheduleRender: function() {
        if (this._renderTimer) {
            clearTimeout(this._renderTimer);
        }
        // 使用 requestAnimationFrame + setTimeout 确保在下一帧执行
        this._renderTimer = requestAnimationFrame(() => {
            this._renderTimer = setTimeout(() => {
                this._renderPreviews();
            }, 16); // ~60fps
        });
    },

    _bindEvents: function() {
        // ============ Prompt 输入框 ============
        const promptEl = document.getElementById('dreaminaPrompt');
        if (promptEl) {
            promptEl.addEventListener('input', (e) => this._onPromptInput(e));
            promptEl.addEventListener('keydown', (e) => this._onPromptKeydown(e));
            promptEl.addEventListener('focus', () => this._onPromptFocus());
            promptEl.addEventListener('dragover', (e) => this._onPromptDragover(e));
            promptEl.addEventListener('drop', (e) => this._onPromptDrop(e));
        }

        // ============ 生成按钮 ============
        const generateBtn = document.getElementById('generateBtn');
        if (generateBtn) {
            generateBtn.addEventListener('click', () => this.handleGenerate());
        }

        // ============ 查看器关闭 ============
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') this.closeViewer();
        });

        // ============ 通用下拉关闭逻辑 ============
        document.addEventListener('click', (e) => {
            const containers = [
                { id: 'video-selector-container', menu: 'videoDropdown' },
                { id: 'model-selector-container', menu: 'model-dropdown-menu' },
                { id: 'omni-selector-container', menu: 'omni-dropdown-menu' },
                { id: 'ratio-selector-container', menu: 'ratio-dropdown-menu' },
                { id: 'duration-selector-container', menu: 'duration-dropdown-menu' }
            ];
            containers.forEach(({ id, menu }) => {
                if (!e.target.closest('#' + id)) {
                    const menuEl = document.getElementById(menu);
                    if (menuEl) menuEl.classList.add('hidden');
                }
            });

            // 关闭 mentionDropdown（点击按钮或菜单本身时不关闭）
            const mentionDropdown = document.getElementById('mentionDropdown');
            const mentionBtn = document.getElementById('mention-trigger-btn');
            if (mentionDropdown && mentionDropdown.style.display !== 'none') {
                if (!e.target.closest('#mention-trigger-btn') && !e.target.closest('#mentionDropdown')) {
                    mentionDropdown.style.display = 'none';
                }
            }
        });

        // ============ Reference 预览卡片事件委托 ============
        const previewContainer = document.getElementById('reference-preview-container');
        if (previewContainer) {
            previewContainer.addEventListener('click', (e) => {
                const card = e.target.closest('.preview-card');
                if (!card) return;
                e.stopPropagation(); // 阻止冒泡，防止触发 reference-dropzone 的打开文件对话框
                const idx = parseInt(card.dataset.index, 10);
                const files = AppState.uploadedFiles || [];
                const file = files[idx];
                if (!file) return;
                // 点击预览 → 改为网页内置查看器弹窗，不再打开系统播放器
                this.openViewer(file);
            });
        }

        // ============ Reference 上传区拖拽 ============
        const refContainer = document.getElementById('reference-dropzone');
        if (refContainer) {
            // 点击打开文件选择
            refContainer.addEventListener('click', (e) => {
                e.stopPropagation();
                if (window.API && window.API.openAndProcessFiles) {
                    window.API.openAndProcessFiles();
                }
            });

            refContainer.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = 'copy';
                refContainer.classList.add('drag-over');
            });
            refContainer.addEventListener('dragleave', (e) => {
                e.preventDefault();
                e.stopPropagation();
                refContainer.classList.remove('drag-over');
            });
            refContainer.addEventListener('drop', (e) => {
                e.preventDefault();
                e.stopPropagation();
                refContainer.classList.remove('drag-over');

                const files = e.dataTransfer?.files;
                if (files && files.length > 0) {
                    const pathPromises = [];
                    for (let i = 0; i < files.length; i++) {
                        const p = (window.electronAPI && window.electronAPI.getPathForFile)
                            ? window.electronAPI.getPathForFile(files[i])
                            : Promise.resolve(files[i].path || files[i].name);
                        pathPromises.push(p);
                    }
                    Promise.all(pathPromises).then((paths) => {
                        console.log('[TabTasks] reference 区拖拽路径:', paths);
                        if (paths.length > 0 && window.API && window.API.processFiles) {
                            window.API.processFiles(paths);
                        }
                    }).catch((err) => {
                        console.error('[TabTasks] reference 区拖拽路径获取失败:', err);
                    });
                }
            });
        }

        console.log('[tab_tasks.js] UI 事件已绑定');
    },

    _subscribeEvents: function() {
        // 文件列表更新 - 添加防抖，避免快速连续删除导致多次渲染
        EventBus.on('files:listUpdated', (files) => {
            console.log('[TabTasks] 收到文件列表更新', files);
            AppState.setUploadedFiles(files || []);
            this._scheduleRender();
        });

        // 文件处理完成
        EventBus.on('files:processed', (result) => {
            console.log('[TabTasks] 收到 files:processed', result);
            if (result.files) {
                AppState.setUploadedFiles(result.files);
                this._scheduleRender();
            }
            if (result.message) {
                EventBus.emit('toast', { message: result.message });
            }
        });

        // 编辑区拖拽完成
        EventBus.on('files:dropped', (data) => {
            console.log('[TabTasks] 收到 files:dropped', data);
            if (data.files && data.files.length > 0) {
                this._insertRefTagsAtCursor(data.files, data.drop_pos);
            }
        });

        // 文件删除
        EventBus.on('file:removed', (data) => {
            console.log('[TabTasks] 收到 file:removed', data);
            // 编辑区标签同步由 EditorTagSync 模块处理
        });

        // 任务进度
        EventBus.on('progress:generate_task', (data) => {
            console.log('[TabTasks] 生成任务进度:', data);
            // TODO: 更新 UI 进度条
        });

        // 任务完成
        EventBus.on('result:generate_task', (data) => {
            console.log('[TabTasks] 生成任务完成:', data);
            this._resetGenerateButton();
            if (data.success) {
                EventBus.emit('toast', { message: data.message || '生成成功' });
            } else {
                EventBus.emit('toast', { message: data.error || '生成失败' });
            }
        });

        console.log('[tab_tasks.js] EventBus 事件已订阅');
    },

    // ============================================================
    // 下拉菜单控制方法
    // ============================================================

    _toggleDropdown: function(dropdownId) {
        const dropdown = document.getElementById(dropdownId);
        if (!dropdown) return;
        const isHidden = dropdown.classList.contains('hidden');
        this._closeAllDropdowns();
        if (isHidden) dropdown.classList.remove('hidden');
    },

    _closeAllDropdowns: function() {
        ['videoDropdown', 'model-dropdown-menu', 'omni-dropdown-menu',
         'ratio-dropdown-menu', 'duration-dropdown-menu'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.classList.add('hidden');
        });
    },

    selectVideo: function(type, element) {
        this._state.type = type;
        AppState.type = type;
        const btn = document.getElementById('aiVideoBtn');
        if (btn) {
            btn.innerHTML = `
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M10 8l6 4-6 4V8z"/></svg>
                ${type}
                <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"/></svg>
            `;
        }

        // 更新菜单中各选项的选中状态
        const menu = document.getElementById('videoDropdown');
        if (menu) {
            const items = menu.querySelectorAll('.video-item');
            items.forEach(item => {
                const isSelected = item.dataset.value === type;
                item.classList.toggle('bg-[#2a2a2d]', isSelected);
                item.classList.toggle('border-transparent', !isSelected);
                const checkIcon = item.querySelector('.check-icon');
                if (checkIcon) {
                    checkIcon.style.display = isSelected ? 'block' : 'none';
                }
            });
        }

        this._closeAllDropdowns();
    },

    selectModel: function(model, element) {
        this._state.model = model;
        AppState.model = model;
        const btn = document.getElementById('model-dropdown-btn');
        if (btn) {
            btn.innerHTML = `
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/>
                </svg>
                ${model} <span class="text-[#00cae0]">✦</span>
            `;
        }

        // 更新菜单中各选项的选中状态
        const menu = document.getElementById('model-dropdown-menu');
        if (menu) {
            const items = menu.querySelectorAll('.model-item');
            items.forEach(item => {
                const isSelected = item.dataset.value === model;
                item.classList.toggle('bg-[#2a2a2d]', isSelected);
                item.classList.toggle('border-transparent', !isSelected);
                const checkIcon = item.querySelector('.check-icon');
                if (checkIcon) {
                    checkIcon.style.display = isSelected ? 'block' : 'none';
                }
            });
        }

        this._closeAllDropdowns();
        const resSection = document.getElementById('resolution-section');
        if (resSection) {
            resSection.classList.toggle('hidden', model !== 'Dreamina Seedance 2.0');
        }
        this._updateRatioButtonUI();
    },

    selectResolution: function(res, element) {
        this._state.resolution = res;
        AppState.resolution = res;

        // 更新菜单中各选项的选中状态
        const resSection = document.getElementById('resolution-section');
        if (resSection) {
            const items = resSection.querySelectorAll('.resolution-item');
            items.forEach(item => {
                const isSelected = item.dataset.value === res;
                if (isSelected) {
                    item.classList.add('bg-[#38383a]', 'text-gray-200', 'shadow-sm');
                    item.classList.remove('bg-transparent', 'text-gray-400', 'hover:bg-[#323235]', 'hover:text-gray-200');
                } else {
                    item.classList.remove('bg-[#38383a]', 'text-gray-200', 'shadow-sm');
                    item.classList.add('bg-transparent', 'text-gray-400', 'hover:bg-[#323235]', 'hover:text-gray-200');
                }
            });
        }

        this._updateRatioButtonUI();
    },

    selectRatio: function(ratio, element) {
        this._state.aspect = ratio;
        AppState.aspect = ratio;

        // 更新菜单中各选项的选中状态
        const menu = document.getElementById('ratio-dropdown-menu');
        if (menu) {
            const items = menu.querySelectorAll('.ratio-item');
            items.forEach(item => {
                const isSelected = item.dataset.value === ratio;
                if (isSelected) {
                    item.classList.add('bg-[#38383a]', 'text-gray-200', 'shadow-sm');
                    item.classList.remove('hover:bg-[#323235]', 'text-gray-400', 'hover:text-gray-200');
                } else {
                    item.classList.remove('bg-[#38383a]', 'text-gray-200', 'shadow-sm');
                    item.classList.add('hover:bg-[#323235]', 'text-gray-400', 'hover:text-gray-200');
                }
            });
        }

        this._updateRatioButtonUI();
        this._closeAllDropdowns();
    },

    selectDuration: function(duration, element) {
        this._state.duration = duration;
        AppState.duration = duration;
        const btn = document.getElementById('duration-dropdown-btn');
        if (btn) {
            btn.innerHTML = `
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="9" stroke-width="1.5"/>
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 7v5l3 3"/>
                </svg>
                ${duration}
            `;
        }

        // 更新菜单中各选项的选中状态
        const menu = document.getElementById('duration-dropdown-menu');
        if (menu) {
            const items = menu.querySelectorAll('.duration-item');
            items.forEach(item => {
                const isSelected = item.dataset.value === duration;
                item.classList.toggle('bg-[#2a2a2d]', isSelected);
                item.classList.toggle('border-transparent', isSelected);
                const checkIcon = item.querySelector('.check-icon');
                if (checkIcon) {
                    checkIcon.style.display = isSelected ? 'block' : 'none';
                }
            });
        }

        this._closeAllDropdowns();
    },

    selectOmni: function(mode, element) {
        this._state.omniMode = mode;
        AppState.omniMode = mode;
        const btn = document.getElementById('omni-dropdown-btn');
        const displayText = mode === 'omni' ? '全能参考' : '首尾帧';
        if (btn) {
            btn.innerHTML = `
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z"/></svg>
                ${displayText}
            `;
        }

        // 更新菜单中各选项的选中状态
        const menu = document.getElementById('omni-dropdown-menu');
        if (menu) {
            const items = menu.querySelectorAll('.omni-item');
            items.forEach(item => {
                const isSelected = item.dataset.value === mode;
                item.classList.toggle('bg-[#2a2a2d]', isSelected);
                item.classList.toggle('border-transparent', !isSelected);
                const checkIcon = item.querySelector('.check-icon');
                if (checkIcon) {
                    checkIcon.style.display = isSelected ? 'block' : 'none';
                }
            });
        }

        this._closeAllDropdowns();

        // 首尾帧模式下禁用比例选择器
        this._updateRatioSelectorState();
    },

    // 更新比例选择器的禁用/启用状态
    _updateRatioSelectorState: function() {
        const container = document.getElementById('ratio-selector-container');
        const btn = document.getElementById('ratio-dropdown-btn');
        const menu = document.getElementById('ratio-dropdown-menu');
        const frameUploaderContainer = document.getElementById('frame-uploader-container');

        if (!container || !btn || !menu) return;

        const isFirstLastMode = this._state.omniMode === 'first_last';

        // 控制 Reference 拖拽区域的显示/隐藏
        const refDropzone = document.getElementById('reference-dropzone');
        if (refDropzone) {
            refDropzone.classList.toggle('hidden', isFirstLastMode);
        }

        if (isFirstLastMode) {
            // 禁用状态
            btn.classList.add('opacity-50', 'cursor-not-allowed');
            btn.classList.remove('hover:bg-gray-800');
            btn.setAttribute('disabled', 'true');
            btn.onclick = null; // 移除点击事件

            // 更新按钮文字为提示信息
            btn.innerHTML = `
                <svg class="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <rect x="3" y="6" width="18" height="12" rx="1.5" stroke-width="1.5"/>
                </svg>
                <span class="text-[10px]">根据输入图片自动适配16:9比例，暂不支持调整</span>
            `;

            // 隐藏菜单（如果有的话）
            menu.classList.add('hidden');

            // 显示首尾帧上传器
            if (frameUploaderContainer) {
                frameUploaderContainer.classList.remove('hidden');

                // 从 AppState 恢复首尾帧数据（如果有的话）
                if (this._frameUploader && AppState.frameFiles) {
                    this._frameUploader.frames = {
                        first: AppState.frameFiles.first || null,
                        last: AppState.frameFiles.last || null
                    };
                    this._frameUploader.previewUrls = {
                        first: AppState.framePreviewUrls.first || null,
                        last: AppState.framePreviewUrls.last || null
                    };
                    this._frameUploader.updateCardUI('first');
                    this._frameUploader.updateCardUI('last');
                }
            }
        } else {
            // 启用状态
            btn.classList.remove('opacity-50', 'cursor-not-allowed');
            btn.classList.add('hover:bg-gray-800');
            btn.removeAttribute('disabled');
            btn.onclick = function() { TabTasks._toggleDropdown('ratio-dropdown-menu'); }; // 恢复点击事件

            // 恢复按钮文字
            this._updateRatioButtonUI();

            // 隐藏首尾帧上传器（不清空数据，只隐藏，让 AppState 保留状态）
            if (frameUploaderContainer) {
                frameUploaderContainer.classList.add('hidden');
                // 注意：不要调用 reset()，否则会清空 AppState 中的首尾帧数据
            }
        }
    },

    _updateRatioButtonUI: function() {
        const btnEl = document.getElementById('ratio-dropdown-btn');
        if (!btnEl) return;
        const isStandardModel = this._state.model === 'Dreamina Seedance 2.0';
        let btnText = this._state.aspect;
        if (isStandardModel) btnText += '  ' + this._state.resolution;
        btnEl.innerHTML = `
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <rect x="3" y="6" width="18" height="12" rx="1.5" stroke-width="1.5"/>
            </svg>
            ${btnText}
        `;
    },

    // ============================================================
    // Prompt 输入框
    // ============================================================

    _onPromptInput: function(e) {
        this._state.prompt = e.target.textContent;
        AppState.prompt = e.target.textContent;

        const selection = window.getSelection();
        if (!selection.rangeCount) { this._hideMentionDropdown(); return; }

        const range = selection.getRangeAt(0);
        const node = range.endContainer;

        if (node.nodeType !== Node.TEXT_NODE) { this._hideMentionDropdown(); return; }

        const text = node.textContent || '';
        const localOffset = range.endOffset;

        let atLocalIndex = -1;
        for (let i = localOffset - 1; i >= 0; i--) {
            if (text[i] === '@') { atLocalIndex = i; break; }
            if (text[i] === ' ' || text[i] === '\n') break;
        }

        if (atLocalIndex >= 0) {
            const afterAt = text.substring(atLocalIndex + 1, localOffset);
            if (!afterAt.includes(' ')) {
                const atGlobalOffset = this._getTextOffset(e.target, node) + atLocalIndex;
                this._mentionState.active = true;
                this._mentionState.startOffset = atGlobalOffset;
                this._mentionState.searchText = afterAt;
                this._mentionState.selectedIndex = -1;
                this._renderMentionDropdown();
                return;
            }
        }

        this._hideMentionDropdown();
    },

    _onPromptKeydown: function(e) {
        const dropdown = document.getElementById('mentionDropdown');

        if (this._mentionState.active && dropdown && dropdown.style.display !== 'none') {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                this._mentionState.selectedIndex = (this._mentionState.selectedIndex + 1) % this._mentionState.items.length;
                this._renderMentionDropdown();
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                this._mentionState.selectedIndex = (this._mentionState.selectedIndex - 1 + this._mentionState.items.length) % this._mentionState.items.length;
                this._renderMentionDropdown();
                return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                this._selectMentionItem(this._mentionState.selectedIndex);
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                this._hideMentionDropdown();
                return;
            }
        }

        if (e.key === 'Enter' && !e.shiftKey) e.preventDefault();

        if (e.key === 'Backspace') {
            const selection = window.getSelection();
            if (!selection.rangeCount) return;
            const range = selection.getRangeAt(0);
            const node = range.endContainer;

            if (this._mentionState.active) {
                const text = node.textContent || '';
                const offset = range.endOffset;
                const afterAt = text.substring(this._mentionState.startOffset + 1, offset);
                if (afterAt.length <= 1) this._hideMentionDropdown();
                return;
            }

            if (node.nodeType === Node.TEXT_NODE) {
                const parent = node.parentElement;
                if (parent && parent.classList.contains('ref-tag')) {
                    e.preventDefault();
                    const idx = parseInt(parent.dataset.index);
                    if (!isNaN(idx)) this._removeFile(idx);
                    parent.remove();
                }
            }
        }
    },

    _onPromptFocus: function() {
        if (!window.getSelection().rangeCount) {
            const editor = document.getElementById('dreaminaPrompt');
            if (editor) {
                const range = document.createRange();
                range.selectNodeContents(editor);
                range.collapse(false);
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
            }
        }
    },

    _onPromptDragover: function(e) {
        e.preventDefault();
        e.stopPropagation();
        const elementUnderMouse = document.elementFromPoint(e.clientX, e.clientY);
        if (elementUnderMouse && elementUnderMouse.closest('.ref-tag')) {
            e.dataTransfer.dropEffect = 'none';
        } else {
            e.dataTransfer.dropEffect = 'copy';
        }
    },

    _onPromptDrop: function(e) {
        e.preventDefault();
        e.stopPropagation();
        const files = e.dataTransfer?.files;
        if (files && files.length > 0) {
            const dropPos = { x: e.clientX, y: e.clientY };
            const pathPromises = [];
            for (let i = 0; i < files.length; i++) {
                const p = (window.electronAPI && window.electronAPI.getPathForFile)
                    ? window.electronAPI.getPathForFile(files[i])
                    : Promise.resolve(files[i].path || files[i].name);
                pathPromises.push(p);
            }
            Promise.all(pathPromises).then((paths) => {
                console.log('[TabTasks] 拖拽文件路径:', paths);
                window.API.processEditorDropFiles(paths, dropPos);
            }).catch((err) => {
                console.error('[TabTasks] 获取拖拽路径失败:', err);
            });
        }
    },

    // ============================================================
    // @ 提及相关
    // ============================================================

    _getTextOffset: function(root, targetNode) {
        let offset = 0;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
        while (walker.nextNode()) {
            if (walker.currentNode === targetNode) return offset;
            offset += walker.currentNode.textContent.length;
        }
        return offset;
    },

    _updateMentionDropdownPosition: function() {
        const dropdown = document.getElementById('mentionDropdown');
        if (!dropdown || !this._mentionState.active) return;
        const editor = document.getElementById('dreaminaPrompt');
        if (!editor) return;

        let atRect = null;
        const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, null);
        let accumulatedOffset = 0;

        while (walker.nextNode()) {
            const node = walker.currentNode;
            const nodeLength = node.textContent.length;
            if (accumulatedOffset + nodeLength > this._mentionState.startOffset) {
                const offsetInNode = this._mentionState.startOffset - accumulatedOffset;
                try {
                    const range = document.createRange();
                    range.setStart(node, offsetInNode);
                    range.setEnd(node, offsetInNode + 1);
                    const rects = range.getClientRects();
                    if (rects.length > 0) atRect = rects[0];
                } catch (e) {}
                break;
            }
            accumulatedOffset += nodeLength;
        }

        if (atRect) {
            dropdown.style.left = (atRect.left + window.scrollX) + 'px';
            dropdown.style.top = (atRect.bottom + 4 + window.scrollY) + 'px';
        }
    },

    _renderMentionDropdown: function() {
        const dropdown = document.getElementById('mentionDropdown');
        const list = document.getElementById('mentionList');
        const empty = document.getElementById('mentionEmpty');
        if (!dropdown || !list) return;

        const isButtonTriggered = this._mentionState._isButtonTriggered;
        const searchText = this._mentionState.searchText.toLowerCase();
        const uploadedFiles = AppState.uploadedFiles || [];

        this._mentionState.items = uploadedFiles.filter(file => {
            if (!searchText) return true;
            return (file.name || '').toLowerCase().includes(searchText);
        });

        if (this._mentionState.items.length === 0) {
            list.innerHTML = '';
            if (empty) empty.classList.remove('hidden');
            dropdown.style.display = 'block';
            this._mentionState.selectedIndex = -1;
            if (isButtonTriggered) {
                this._positionDropdownAtButton();
            } else {
                this._updateMentionDropdownPosition();
            }
            return;
        }

        if (empty) empty.classList.add('hidden');

        list.innerHTML = this._mentionState.items.map((file, idx) => {
            const type = file.type || 'file';
            const fileIndex = uploadedFiles.indexOf(file);
            const typeCount = this._getTypeCount(type, fileIndex);
            const isSelected = idx === this._mentionState.selectedIndex;
            const thumbHtml = type === 'audio'
                ? '<svg width="18" height="18" fill="none" stroke="rgb(0, 202, 224)" stroke-width="2" viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>'
                : '<img src="' + (file.thumbnail_base64 || file.url || '') + '" alt="">';
            const clickHandler = isButtonTriggered
                ? `onclick="TabTasks._selectMentionItemFixed(${idx})"`
                : `onclick="TabTasks._selectMentionItem(${idx})"`;
            return `
                <div class="mention-item ${isSelected ? 'selected' : ''}" data-index="${idx}" ${clickHandler}>
                    <div class="mention-item-thumb">${thumbHtml}</div>
                    <span class="mention-item-badge ${type}">${type.charAt(0).toUpperCase() + type.slice(1)}${typeCount}</span>
                </div>
            `;
        }).join('');

        dropdown.style.display = 'block';
        if (isButtonTriggered) {
            this._positionDropdownAtButton();
        } else {
            this._updateMentionDropdownPosition();
        }
    },

    // 按钮触发的@菜单定位到按钮下方
    _positionDropdownAtButton: function() {
        const dropdown = document.getElementById('mentionDropdown');
        const btn = document.getElementById('mention-trigger-btn');
        if (!dropdown || !btn) return;

        const rect = btn.getBoundingClientRect();
        dropdown.style.top = (rect.bottom + 4) + 'px';
        dropdown.style.left = rect.left + 'px';
    },

    _hideMentionDropdown: function() {
        const dropdown = document.getElementById('mentionDropdown');
        if (dropdown) dropdown.style.display = 'none';
        this._mentionState.active = false;
        this._mentionState.searchText = '';
        this._mentionState.items = [];
    },

    _toggleMentionDropdownFixed: function() {
        const dropdown = document.getElementById('mentionDropdown');
        if (!dropdown) return;

        if (dropdown.style.display !== 'none') {
            dropdown.style.display = 'none';
            return;
        }

        // 显示下拉菜单，使用按钮位置定位
        const btn = document.getElementById('mention-trigger-btn');
        if (btn) {
            const rect = btn.getBoundingClientRect();
            dropdown.style.top = (rect.bottom + 4) + 'px';
            dropdown.style.left = rect.left + 'px';
        }

        // 重置状态，设置 startOffset 为末尾位置（和手动@一致的插入逻辑）
        this._mentionState.active = true;
        this._mentionState.searchText = '';
        this._mentionState.selectedIndex = 0;
        this._mentionState._isButtonTriggered = true;  // 标记为按钮触发

        this._renderMentionDropdown();
    },

    // 按钮触发的@选择 - 直接在末尾插入
    _selectMentionItemFixed: function(idx) {
        if (idx < 0 || idx >= this._mentionState.items.length) return;

        const file = this._mentionState.items[idx];
        const editor = document.getElementById('dreaminaPrompt');
        if (!editor) return;

        editor.focus();

        // 设置光标到编辑器末尾
        const selection = window.getSelection();
        const cursorRange = document.createRange();
        cursorRange.selectNodeContents(editor);
        cursorRange.collapse(false);

        // 确保光标不在 ref-tag 内部
        const safeRange = this._ensureCursorOutsideTags(editor, cursorRange);
        selection.removeAllRanges();
        selection.addRange(safeRange);

        const type = file.type || 'file';
        const index = AppState.uploadedFiles.indexOf(file);

        const tag = document.createElement('span');
        tag.className = 'ref-tag ' + type;
        tag.contentEditable = 'false';
        tag.dataset.index = index;
        tag.dataset.type = type;
        tag.dataset.path = file.path || '';
        tag.dataset.name = file.name || '';
        tag.dataset.url = file.url || '';

        if (type === 'audio') {
            tag.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgb(0, 202, 224)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
        } else {
            const thumbSrc = file.thumbnail_base64 || file.url || '';
            if (thumbSrc) tag.innerHTML = '<img src="' + thumbSrc + '" alt="">';
        }

        const nameSpan = document.createElement('span');
        nameSpan.className = 'ref-name';
        nameSpan.textContent = type.charAt(0).toUpperCase() + type.slice(1) + this._getTypeCount(type, index);
        tag.appendChild(nameSpan);

        tag.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const idx = parseInt(tag.dataset.index);
            const f = AppState.uploadedFiles[idx];
            if (f) {
                this.openViewer(f);
            }
        });

        // 插入标签
        const currentRange = selection.getRangeAt(0);
        currentRange.deleteContents();
        currentRange.insertNode(tag);
        currentRange.setStartAfter(tag);
        currentRange.collapse(true);
        selection.removeAllRanges();
        selection.addRange(currentRange);

        editor.dispatchEvent(new Event('input', { bubbles: true }));

        // 关闭下拉菜单
        const dropdown = document.getElementById('mentionDropdown');
        if (dropdown) dropdown.style.display = 'none';
        this._mentionState.active = false;
        this._mentionState._isButtonTriggered = false;
    },

    _selectMentionItem: function(idx) {
        if (idx < 0 || idx >= this._mentionState.items.length) return;

        const file = this._mentionState.items[idx];
        const editor = document.getElementById('dreaminaPrompt');
        if (!editor) return;

        const startGlobalOffset = this._mentionState.startOffset;
        const endGlobalOffset = startGlobalOffset + 1 + this._mentionState.searchText.length;

        let atNode = null, atNodeOffset = 0, endNode = null, endNodeOffset = 0;
        let accOffset = 0;

        const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, null);
        while (walker.nextNode()) {
            const node = walker.currentNode;
            const nodeLen = node.textContent.length;
            if (!atNode && accOffset + nodeLen > startGlobalOffset) {
                atNode = node;
                atNodeOffset = startGlobalOffset - accOffset;
            }
            if (accOffset + nodeLen >= endGlobalOffset) {
                endNode = node;
                endNodeOffset = endGlobalOffset - accOffset;
                break;
            }
            accOffset += nodeLen;
        }

        if (!atNode || !endNode) { this._hideMentionDropdown(); return; }

        const deleteRange = document.createRange();
        deleteRange.setStart(atNode, atNodeOffset);
        deleteRange.setEnd(endNode, endNodeOffset);
        deleteRange.deleteContents();

        const type = file.type || 'file';
        const tag = document.createElement('span');
        tag.className = 'ref-tag ' + type;
        tag.contentEditable = 'false';
        tag.dataset.index = AppState.uploadedFiles.indexOf(file);
        tag.dataset.type = type;
        tag.dataset.path = file.path || '';
        tag.dataset.name = file.name || '';
        tag.dataset.url = file.url || '';

        if (type === 'audio') {
            tag.innerHTML = '<svg width="16" height="16" fill="none" stroke="rgb(0, 202, 224)" stroke-width="2" viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
        } else {
            const thumbSrc = file.thumbnail_base64 || file.url || '';
            if (thumbSrc) tag.innerHTML = '<img src="' + thumbSrc + '" alt="">';
        }

        const nameSpan = document.createElement('span');
        nameSpan.className = 'ref-name';
        const fileIndex = AppState.uploadedFiles.indexOf(file);
        nameSpan.textContent = type.charAt(0).toUpperCase() + type.slice(1) + this._getTypeCount(type, fileIndex);
        tag.appendChild(nameSpan);

        tag.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const idx = parseInt(tag.dataset.index);
            const f = AppState.uploadedFiles[idx];
            if (f) {
                this.openViewer(f);
            }
        });

        const insertRange = document.createRange();
        insertRange.setStart(atNode, atNodeOffset);
        insertRange.collapse(true);
        insertRange.insertNode(tag);

        const spaceNode = document.createTextNode('\u200B');
        tag.parentNode.insertBefore(spaceNode, tag.nextSibling);

        editor.focus();
        const newSel = window.getSelection();
        const afterTagRange = document.createRange();
        afterTagRange.setStartAfter(spaceNode);
        afterTagRange.collapse(true);
        newSel.removeAllRanges();
        newSel.addRange(afterTagRange);

        this._hideMentionDropdown();
        editor.dispatchEvent(new Event('input', { bubbles: true }));
    },

    // ============================================================
    // 生成任务
    // ============================================================

    handleGenerate: function() {
        if (!AppState.serverRunning) {
            EventBus.emit('toast', { message: '服务未就绪，请稍候...' });
            return;
        }

        const prompt = document.getElementById('dreaminaPrompt')?.textContent?.trim() || '';

        if (!prompt) {
            EventBus.emit('toast', { message: '请输入描述词' });
            return;
        }

        const params = {
            type: this._state.type,
            model: this._state.model,
            mode: this._state.mode,
            aspect: this._state.aspect,
            resolution: this._state.resolution,
            duration: this._state.duration,
            intensity: this._state.intensity,
            prompt: this._state.prompt,
            files: (AppState.uploadedFiles || []).map(f => ({ name: f.name, path: f.path, type: f.type }))
        };

        console.log('[TabTasks] 发起生成任务', params);

        // 通过 WebSocket 发送（保持实时性）
        const sent = window.wsClient.send({
            type: 'GENERATE_TASK',
            ...params
        });

        if (!sent) {
            // WebSocket 未连接时降级为 HTTP
            console.warn('[TabTasks] WebSocket 未连接，尝试 HTTP');
            window.httpClient.post('/api/generate', params).then(result => {
                console.log('[TabTasks] HTTP 生成结果:', result);
                this._resetGenerateButton();
                EventBus.emit('toast', { message: result.message || '请求已发送' });
            }).catch(err => {
                console.error('[TabTasks] HTTP 生成失败:', err);
                this._resetGenerateButton();
                EventBus.emit('toast', { message: '请求失败: ' + err.message });
            });
            return;
        }

        EventBus.emit('toast', { message: '生成请求已发送' });
        this._showGeneratingState();
    },

    _showGeneratingState: function() {
        const btn = document.getElementById('generateBtn');
        if (!btn) return;
        btn.disabled = true;
        btn.innerHTML = `
            <svg class="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10" stroke-opacity="0.25"/>
                <path d="M12 2a10 10 0 0 1 10 10"/>
            </svg>
            生成中...
        `;
    },

    _resetGenerateButton: function() {
        const btn = document.getElementById('generateBtn');
        if (!btn) return;
        btn.disabled = false;
        btn.innerHTML = `
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/>
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
            </svg>
            Generate
        `;
    },

    // ============================================================
    // 素材预览卡片
    // ============================================================

    /**
     * 计算指定文件在其类型序列中的序号（从1开始）
     * @param {string} type - 文件类型（image/video/audio）
     * @param {number} fileIndex - 文件在 uploadedFiles 数组中的全局下标
     * @returns {number} 该类型从1开始的序号
     */
    _getTypeCount: function(type, fileIndex) {
        const files = AppState.uploadedFiles || [];
        let count = 0;
        for (let i = 0; i <= fileIndex; i++) {
            if ((files[i] || {}).type === type) count++;
        }
        return count;
    },

    _renderPreviews: function() {
        const container = document.getElementById('reference-preview-container');
        if (!container) return;

        const uploadedFiles = AppState.uploadedFiles || [];

        if (uploadedFiles.length === 0) {
            container.innerHTML = `
                <div class="placeholder-card absolute inset-0 bg-[#2a2a2d] rounded-lg transform -rotate-3 flex flex-col items-center justify-center text-gray-500 text-[11px] group-hover:bg-[#323235] group-hover:scale-105 transition-all duration-200 border border-dashed border-gray-600/50">
                    <svg class="w-4 h-4 mb-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path>
                    </svg>
                    <span>Referenc</span>
                </div>
            `;
            return;
        }

        // 使用 DocumentFragment 批量构建 DOM，减少 reflow
        const fragment = document.createDocumentFragment();
        const totalCount = uploadedFiles.length;

        let imgCount = 0, vidCount = 0, audCount = 0;

        try {
            uploadedFiles.forEach((file, index) => {
                const isTopCard = index === totalCount - 1;
                const angleClass = isTopCard ? 'rotate-0' : this.STACK_ANGLES[index % this.STACK_ANGLES.length];
                const zIndex = 10 + index;
                const expandX = index * 80;
                const expandRot = (index % 2 === 0 ? '-2deg' : '2deg');

                let bgClass = 'bg-[#1c1c1e]';
                let typeLabel = '';
                let cardContent = '';
                const fileType = file.type || 'unknown';

                if (fileType === 'image') {
                    imgCount++;
                    typeLabel = 'Image' + imgCount;
                    const safePath = file.path ? 'app-media://local/' + file.path.replace(/\\/g, '/') : '';
                    const imgSrc = file.thumbnail_base64 || safePath || file.url || '';
                    cardContent = '<img src="' + imgSrc + '" class="w-full h-full object-cover rounded-md" />';
                } else if (fileType === 'video') {
                    vidCount++;
                    typeLabel = 'Video' + vidCount;
                    cardContent = '<img src="' + (file.thumbnail_base64 || '') + '" class="w-full h-full object-cover rounded-md" />' +
                        '<div class="absolute bottom-1 left-1 bg-black/60 px-1 rounded text-white text-[8px] font-bold">' + (file.duration || '00:00') + '</div>';
                } else if (fileType === 'audio') {
                    audCount++;
                    typeLabel = 'Audio' + audCount;
                    bgClass = 'bg-[#5a6b82]';
                    cardContent = '<div class="flex flex-col items-center justify-center h-full w-full">' +
                        '<svg class="w-6 h-6 text-white mb-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3"/></svg>' +
                        '<span class="text-white text-[10px] font-medium leading-none">' + typeLabel + '</span>' +
                        '</div>';
                } else {
                    typeLabel = 'File';
                    bgClass = 'bg-[#3a3a3a]';
                    cardContent = '<div class="flex flex-col items-center justify-center h-full w-full">' +
                        '<svg class="w-6 h-6 text-gray-400 mb-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"/></svg>' +
                        '<span class="text-gray-400 text-[10px] font-medium leading-none">' + typeLabel + '</span>' +
                        '</div>';
                }

                // 使用 template 解析 HTML，减少字符串拼接
                const cardDiv = document.createElement('div');
                cardDiv.className = 'preview-card group absolute inset-0 ' + bgClass + ' rounded-lg border-2 border-white shadow-lg transform ' + angleClass + ' cursor-pointer';
                cardDiv.style.cssText = 'z-index: ' + zIndex + '; --expand-x: ' + expandX + 'px; --expand-rot: ' + expandRot + ';';
                cardDiv.dataset.index = index;

                cardDiv.innerHTML = `
                    <div class="absolute -top-8 left-1/2 transform -translate-x-1/2 bg-[#2a2a2d] border border-[#3c3c3e] text-gray-200 text-[10px] px-2 py-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap shadow-lg pointer-events-none z-50">
                        ${typeLabel}
                    </div>
                    <div class="absolute -top-1.5 -right-1.5 w-4 h-4 bg-[#1c1c1e] border border-gray-500 rounded-full flex items-center justify-center text-gray-300 opacity-0 group-hover:opacity-100 hover:bg-red-500 hover:text-white hover:border-red-500 transition-all z-50 cursor-pointer" onclick="event.stopPropagation(); TabTasks._removeFile(${index});" title="Remove">
                        <svg class="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M6 18L18 6M6 6l12 12"></path></svg>
                    </div>
                    ${cardContent}
                    ${isTopCard && totalCount < this.MAX_TOTAL ? `
                    <div class="absolute -bottom-2 -right-2 w-7 h-7 bg-[#38383a] border-[3px] border-[#1c1c1e] rounded-full flex items-center justify-center text-white shadow-xl hover:bg-[#48484a] transition-colors cursor-pointer z-50" onclick="event.stopPropagation(); TabTasks._openFileDialog();" title="Add more">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 4v16m8-8H4"></path></svg>
                    </div>` : ''}
                `;

                fragment.appendChild(cardDiv);
            });

            // 一次性替换容器内容
            container.innerHTML = '';
            container.appendChild(fragment);
        } catch (err) {
            console.error('[TabTasks] 渲染卡片失败:', err);
        }
    },

    /**
     * 打开文件选择对话框
     */
    _openFileDialog: function() {
        window.API.openAndProcessFiles();
    },

    _removeFile: async function(index) {
        // 防抖：防止快速连续点击删除按钮
        if (this._removing) return;
        this._removing = true;

        console.log('[TabTasks] 请求删除文件: index=', index);
        try {
            await window.API.removeFile(index);
        } catch (err) {
            console.error('[TabTasks] 删除文件失败:', err);
        } finally {
            // 延迟重置标志，允许下一次删除
            setTimeout(() => { this._removing = false; }, 300);
        }
    },

    // ============================================================
    // 查看器（网页内置，不依赖本地播放器）
    // ============================================================

    /**
     * 将 Windows 绝对路径转换为 file:// URL
     * D:\path\to\file.mp4 → app-media://local/D:/path/to/file.mp4
     */
    _pathToFileUrl: function(filePath) {
        if (!filePath) return '';
        // 已经是 file:// URL 则直接返回
        if (filePath.startsWith('app-media://') || filePath.startsWith('file://') || filePath.startsWith('data:') || filePath.startsWith('blob:')) {
            return filePath;
        }
        // Windows 路径：D:\xxx → /D:/xxx，加入 local/ 防止盘符解析 Bug
        const normalized = filePath.replace(/\\/g, '/');
        return 'app-media://local/' + normalized;
    },

    openViewer: function(file) {
        const overlay = document.getElementById('viewerOverlay');
        const imgEl = document.getElementById('viewerImage');
        const videoEl = document.getElementById('viewerVideo');
        const audioEl = document.getElementById('viewerAudio');
        const infoEl = document.getElementById('viewerInfo');
        const pathEl = document.getElementById('viewerFilePath');

        if (!overlay) return;

        // 停止并重置所有媒体元素
        videoEl.pause();
        videoEl.src = '';
        videoEl.style.display = 'none';
        audioEl.pause();
        audioEl.src = '';
        audioEl.style.display = 'none';
        imgEl.style.display = 'none';
        imgEl.src = '';

        const type = file.type || 'unknown';
        const src = file.thumbnail_base64 || file.path || file.url || '';
        const fileName = file.name || (file.path ? file.path.split(/[\\/]/).pop() : '未知文件');
        const filePath = file.path || '';

        // 显示原文件路径（供插件使用）
        if (pathEl) {
            if (filePath) {
                pathEl.textContent = filePath;
                pathEl.style.display = 'block';
            } else {
                pathEl.style.display = 'none';
            }
        }

        if (type === 'video') {
            const videoUrl = file.path ? this._pathToFileUrl(file.path) : src;
            if (videoUrl) {
                videoEl.src = videoUrl;
                videoEl.style.display = 'block';
                infoEl.textContent = fileName + (file.duration ? ' · ' + file.duration : '');
            }
        } else if (type === 'audio') {
            const audioUrl = file.path ? this._pathToFileUrl(file.path) : src;
            if (audioUrl) {
                audioEl.src = audioUrl;
                audioEl.style.display = 'block';
                infoEl.textContent = fileName + (file.duration ? ' · ' + file.duration : '');
            }
        } else if (type === 'image') {
            const imgUrl = file.thumbnail_base64 || (file.path ? this._pathToFileUrl(file.path) : src);
            if (imgUrl) {
                imgEl.src = imgUrl;
                imgEl.style.display = 'block';
                infoEl.textContent = fileName;
            }
        } else {
            // 未知类型，尝试直接用路径
            if (src) {
                const fallbackUrl = src.startsWith('file:') || src.startsWith('http') ? src : this._pathToFileUrl(src);
                if (fallbackUrl.startsWith('app-media://') || fallbackUrl.startsWith('file:///') || fallbackUrl.startsWith('http')) {
                    imgEl.src = fallbackUrl;
                    imgEl.style.display = 'block';
                    infoEl.textContent = fileName;
                }
            }
        }

        overlay.classList.add('show');
    },

    closeViewer: function(e) {
        if (e && e.target !== e.currentTarget) return;
        const overlay = document.getElementById('viewerOverlay');
        if (overlay) overlay.classList.remove('show');
        const videoEl = document.getElementById('viewerVideo');
        const audioEl = document.getElementById('viewerAudio');
        if (videoEl) videoEl.pause();
        if (audioEl) audioEl.pause();
    },

    // ============================================================
    // 素材标签插入
    // ============================================================

    /**
     * 确保光标不会落在 ref-tag 内部，防止拖拽时新标签嵌套进旧标签
     */
    _ensureCursorOutsideTags: function(editor, cursorRange) {
        if (!cursorRange) return cursorRange;
        const container = cursorRange.startContainer;
        let currentNode = container;

        while (currentNode && currentNode !== editor) {
            if (currentNode.classList && currentNode.classList.contains('ref-tag')) {
                const newRange = document.createRange();
                newRange.setStartAfter(currentNode);
                newRange.collapse(true);
                return newRange;
            }
            currentNode = currentNode.parentNode;
        }
        return cursorRange;
    },

    _insertRefTagsAtCursor: function(files, dropPos) {
        if (!files || files.length === 0) return;

        const editor = document.getElementById('dreaminaPrompt');
        if (!editor) return;

        editor.focus();

        let cursorRange = null;
        if (dropPos && dropPos.x !== undefined && dropPos.y !== undefined) {
            if (document.caretRangeFromPoint) {
                cursorRange = document.caretRangeFromPoint(dropPos.x, dropPos.y);
            } else if (document.caretPositionFromPoint) {
                var pos = document.caretPositionFromPoint(dropPos.x, dropPos.y);
                if (pos) {
                    cursorRange = document.createRange();
                    cursorRange.setStart(pos.offsetNode, pos.offset);
                    cursorRange.collapse(true);
                }
            }

            if (cursorRange) {
                if (!editor.contains(cursorRange.startContainer) && editor !== cursorRange.startContainer) {
                    cursorRange = document.createRange();
                    cursorRange.selectNodeContents(editor);
                    cursorRange.collapse(false);
                }
            }
        }

        if (!cursorRange) {
            cursorRange = document.createRange();
            cursorRange.selectNodeContents(editor);
            cursorRange.collapse(false);
        }

        // 防止新标签嵌套进已有的 ref-tag
        cursorRange = this._ensureCursorOutsideTags(editor, cursorRange);

        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(cursorRange);

        const uploadedFiles = AppState.uploadedFiles || [];

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const index = file.insert_index !== undefined ? file.insert_index : uploadedFiles.length;
            const type = file.type || 'file';

            const tag = document.createElement('span');
            tag.className = 'ref-tag ' + type;
            tag.contentEditable = 'false';
            tag.dataset.index = index;
            tag.dataset.type = type;
            tag.dataset.path = file.path || '';
            tag.dataset.name = file.name || '';
            tag.dataset.url = file.url || '';

            if (type === 'audio') {
                tag.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgb(0, 202, 224)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
            } else {
                const thumbSrc = file.thumbnail_base64 || file.url || '';
                if (thumbSrc) tag.innerHTML = '<img src="' + thumbSrc + '" alt="">';
            }

            const nameSpan = document.createElement('span');
            nameSpan.className = 'ref-name';
            nameSpan.textContent = type.charAt(0).toUpperCase() + type.slice(1) + this._getTypeCount(type, index);
            tag.appendChild(nameSpan);

            tag.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const idx = parseInt(tag.dataset.index);
                const f = AppState.uploadedFiles[idx];
                if (f) {
                    this.openViewer(f);
                }
            });

            const currentRange = selection.getRangeAt(0);
            currentRange.deleteContents();
            currentRange.insertNode(tag);
            currentRange.setStartAfter(tag);
            currentRange.collapse(true);
            selection.removeAllRanges();
            selection.addRange(currentRange);
        }

        editor.dispatchEvent(new Event('input', { bubbles: true }));
        console.log('[TabTasks] 已插入', files.length, '个标签到光标位置');
    }
};

// 确保 TabTasks 在 init 前已挂到 window（供 HTML onclick 调用）
window.TabTasks = TabTasks;

// HTML 中的全局 onclick 函数映射
window.toggleVideoDropdown = function() { TabTasks._toggleDropdown('videoDropdown'); };
window.selectVideo = function(type, el) { TabTasks.selectVideo(type, el); };
window.toggleModelDropdown = function() { TabTasks._toggleDropdown('model-dropdown-menu'); };
window.selectModel = function(model, el) { TabTasks.selectModel(model, el); };
window.toggleOmniDropdown = function() { TabTasks._toggleDropdown('omni-dropdown-menu'); };
window.selectOmni = function(mode, el) { TabTasks.selectOmni(mode, el); };
window.toggleRatioDropdown = function() { TabTasks._toggleDropdown('ratio-dropdown-menu'); };
window.selectRatio = function(ratio, el) { TabTasks.selectRatio(ratio, el); };
window.selectResolution = function(res, el) { TabTasks.selectResolution(res, el); };
window.toggleDurationDropdown = function() { TabTasks._toggleDropdown('duration-dropdown-menu'); };
window.selectDuration = function(duration, el) { TabTasks.selectDuration(duration, el); };
window.toggleMentionDropdownFixed = function() { TabTasks._toggleMentionDropdownFixed(); };
window.selectMentionItem = function(idx) { TabTasks._selectMentionItem(idx); };
window.removeFile = function(idx) { TabTasks._removeFile(idx); };
window.openViewer = function(file) { TabTasks.openViewer(file); };
window.closeViewer = function(e) { TabTasks.closeViewer(e); };

// 导出给 app.js（TabService 同理）
export { TabTasks };

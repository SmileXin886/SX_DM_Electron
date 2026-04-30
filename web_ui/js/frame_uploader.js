/**
 * 首尾帧上传组件 (frame_uploader.js)
 * ================================
 * 采用纯前端无状态架构，独立维护图片物理路径，与后端及全局 AppState 完全物理隔离。
 */

class FrameUploader {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        if (!this.container) {
            console.error(`FrameUploader: 找不到容器 #${containerId}`);
            return;
        }

        // 【核心修改】：初始化时，优先从全局 AppState 的专属存储区恢复数据
        this.frames = {
            first: window.AppState?.frameFiles?.first || null,
            last: window.AppState?.frameFiles?.last || null
        };
        this.previewUrls = {
            first: window.AppState?.framePreviewUrls?.first || null,
            last: window.AppState?.framePreviewUrls?.last || null
        };

        this.render();
        this.bindEvents();

        // 【核心修改】：渲染完毕后，立马刷新一下 UI，把记住的图片显示出来
        this.updateCardUI('first');
        this.updateCardUI('last');
    }

    render() {
        this.container.innerHTML = `
            <div class="flex items-center gap-2 p-1">
                <!-- 首帧 -->
                <div id="card-first" data-type="first"
                     class="w-16 h-20 bg-[#2a2a2d] border border-dashed border-gray-600/50 rounded-lg flex flex-col justify-center items-center cursor-pointer relative overflow-hidden transition-all duration-300 hover:border-[#6b6b6d] hover:bg-[#323235] hover:scale-105 hover:z-10 hover:rotate-0 hover:translate-y-0 -rotate-3 translate-y-0.5">
                    
                    <!-- 核心修改：使用 img 标签进行预览，彻底抛弃 background-image -->
                    <img id="preview-first" class="absolute inset-0 w-full h-full object-cover hidden" src="" alt="首帧预览">
                    
                    <div id="content-first" class="flex flex-col items-center text-gray-500 pointer-events-none z-10">
                        <svg class="w-4 h-4 mb-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path></svg>
                        <span class="text-[10px]">首帧</span>
                    </div>
                </div>

                <!-- 调换按钮 -->
                <div id="btn-swap" class="text-[#767678] cursor-pointer p-0.5 flex items-center justify-center transition-all duration-200 hover:text-gray-200 hover:scale-110" title="互换首尾帧">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M17 4l4 4-4 4"></path>
                        <path d="M3 8h18"></path>
                        <path d="M7 20l-4-4 4-4"></path>
                        <path d="M21 16H3"></path>
                    </svg>
                </div>

                <!-- 尾帧 -->
                <div id="card-last" data-type="last"
                     class="w-16 h-20 bg-[#2a2a2d] border border-dashed border-gray-600/50 rounded-lg flex flex-col justify-center items-center cursor-pointer relative overflow-hidden transition-all duration-300 hover:border-[#6b6b6d] hover:bg-[#323235] hover:scale-105 hover:z-10 hover:rotate-0 hover:translate-y-0 rotate-3 translate-y-0.5">
                    
                    <!-- 核心修改：使用 img 标签进行预览，彻底抛弃 background-image -->
                    <img id="preview-last" class="absolute inset-0 w-full h-full object-cover hidden" src="" alt="尾帧预览">
                    
                    <div id="content-last" class="flex flex-col items-center text-gray-500 pointer-events-none z-10">
                        <svg class="w-4 h-4 mb-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path></svg>
                        <span class="text-[10px]">尾帧</span>
                    </div>
                </div>
            </div>
        `;
    }

    bindEvents() {
        const types = ['first', 'last'];

        types.forEach(type => {
            const card = this.container.querySelector(`#card-${type}`);

            // 1. 点击上传（调用 Electron 原生弹窗获取绝对路径）
            card.addEventListener('click', async () => {
                if (window.electronAPI) {
                    const result = await window.electronAPI.openFileDialog({
                        title: type === 'first' ? '选择首帧图片' : '选择尾帧图片',
                        filters: [{ name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }],
                        properties: ['openFile']
                    });

                    if (!result.canceled && result.filePaths && result.filePaths.length > 0) {
                        this.handleLocalFile(type, result.filePaths[0]);
                    }
                } else {
                    console.warn("FrameUploader: electronAPI 未就绪");
                }
            });

            // 2. 拖拽样式交互
            card.addEventListener('dragover', (e) => {
                e.preventDefault(); e.stopPropagation();
                card.classList.add('border-[#6b6b6d]', 'bg-[#353538]', 'scale-105', 'rotate-0', 'translate-y-0');
            });
            card.addEventListener('dragleave', (e) => {
                e.preventDefault(); e.stopPropagation();
                card.classList.remove('border-[#6b6b6d]', 'bg-[#353538]', 'scale-105', 'rotate-0', 'translate-y-0');
            });

            // 3. 拖拽获取原生绝对路径
            card.addEventListener('drop', async (e) => {
                e.preventDefault(); e.stopPropagation();
                card.classList.remove('border-[#6b6b6d]', 'bg-[#353538]', 'scale-105', 'rotate-0', 'translate-y-0');
                
                if (e.dataTransfer.files.length > 0) {
                    const file = e.dataTransfer.files[0];
                    let filePath = file.path;
                    // 通过 electronAPI 拿到真实的物理路径
                    if (!filePath && window.electronAPI && window.electronAPI.getPathForFile) {
                        filePath = await window.electronAPI.getPathForFile(file);
                    }
                    if (filePath) {
                        const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
                        if (['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'].includes(ext)) {
                            this.handleLocalFile(type, filePath);
                        } else {
                            if (window.showToast) window.showToast('首尾帧只能上传图片格式！');
                        }
                    }
                }
            });
        });

        // 互换按钮事件
        this.container.querySelector('#btn-swap').addEventListener('click', () => this.swapFrames());
    }

    handleLocalFile(type, filePath) {
        this.frames[type] = filePath;

        const formattedPath = filePath.replace(/\\/g, '/');
        const encodedPath = encodeURI(formattedPath).replace(/#/g, '%23').replace(/\?/g, '%3F');
        const previewUrl = 'app-media://local/' + encodedPath;
        this.previewUrls[type] = previewUrl;

        // 【新增】：同步存入全局 AppState 专属区域，保证切换模式不丢失
        if (window.AppState) {
            window.AppState.setFrameFile(type, filePath, previewUrl);
        }

        this.updateCardUI(type);

        if (typeof EventBus !== 'undefined') {
            EventBus.emit('frame:changed', { type, file: filePath, frames: this.getFrames() });
        }
    }

    updateCardUI(type) {
        const card = this.container.querySelector(`#card-${type}`);
        const content = this.container.querySelector(`#content-${type}`);
        const previewImg = this.container.querySelector(`#preview-${type}`);

        if (this.previewUrls[type]) {
            // 直接赋值给 img 的 src 属性，完美兼容各种带空格和特殊字符的路径
            previewImg.src = this.previewUrls[type];
            previewImg.classList.remove('hidden');
            
            card.classList.remove('border-dashed');
            card.classList.add('border-solid', 'border-[#00cae0]');
            content.style.display = 'none';
        } else {
            previewImg.src = '';
            previewImg.classList.add('hidden');
            
            card.classList.add('border-dashed');
            card.classList.remove('border-solid', 'border-[#00cae0]');
            content.style.display = 'flex';
        }
    }

    swapFrames() {
        [this.frames.first, this.frames.last] = [this.frames.last, this.frames.first];
        [this.previewUrls.first, this.previewUrls.last] = [this.previewUrls.last, this.previewUrls.first];

        // 【新增】：同步交换 AppState 里的数据
        if (window.AppState) {
            window.AppState.swapFrames();
        }

        this.updateCardUI('first');
        this.updateCardUI('last');

        if (typeof EventBus !== 'undefined') {
            EventBus.emit('frame:swapped', { frames: this.getFrames() });
        }
    }

    getFrames() {
        return { firstFrame: this.frames.first, lastFrame: this.frames.last };
    }

    isComplete() {
        return this.frames.first !== null && this.frames.last !== null;
    }

    reset() {
        this.frames = { first: null, last: null };
        this.previewUrls = { first: null, last: null };

        // 【新增】：同步清空 AppState 里的数据
        if (window.AppState) {
            window.AppState.clearFrames();
        }

        this.updateCardUI('first');
        this.updateCardUI('last');
        if (typeof EventBus !== 'undefined') {
            EventBus.emit('frame:reset');
        }
    }

    destroy() {
        this.reset();
        if (this.container) this.container.innerHTML = '';
    }
}

// 挂载到全局
window.FrameUploader = FrameUploader;
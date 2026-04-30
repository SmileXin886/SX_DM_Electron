/**
 * 首尾帧上传组件 (frame_uploader.js)
 * ================================
 * 用于"首尾帧"模式下上传首帧和尾帧图片
 *
 * 【使用方式】
 * - 在 tab_tasks.js 中通过 TabTasks._frameUploader 访问
 * - 调用 getFrames() 获取 { firstFrame, lastFrame } 文件对象
 */

class FrameUploader {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        if (!this.container) {
            console.error(`FrameUploader: 找不到容器 #${containerId}`);
            return;
        }

        this.frames = { first: null, last: null };
        this.previewUrls = { first: null, last: null };

        this.render();
        this.bindEvents();
    }

    render() {
        this.container.innerHTML = `
            <div class="flex items-center gap-2 p-1">
                <!-- 首帧 (带向左倾斜 -rotate-6) -->
                <div id="card-first" data-type="first"
                     class="w-16 h-20 bg-[#2a2a2d] border border-dashed border-gray-600/50 rounded-lg flex flex-col justify-center items-center cursor-pointer relative overflow-hidden transition-all duration-300 hover:border-[#6b6b6d] hover:bg-[#323235] hover:scale-105 hover:z-10 hover:rotate-0 hover:translate-y-0 bg-cover bg-center -rotate-3 translate-y-0.5">
                    <input type="file" id="input-first" accept="image/*" class="hidden">
                    <div id="content-first" class="flex flex-col items-center text-gray-500 pointer-events-none">
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

                <!-- 尾帧 (带向右倾斜 rotate-6) -->
                <div id="card-last" data-type="last"
                     class="w-16 h-20 bg-[#2a2a2d] border border-dashed border-gray-600/50 rounded-lg flex flex-col justify-center items-center cursor-pointer relative overflow-hidden transition-all duration-300 hover:border-[#6b6b6d] hover:bg-[#323235] hover:scale-105 hover:z-10 hover:rotate-0 hover:translate-y-0 bg-cover bg-center rotate-3 translate-y-0.5">
                    <input type="file" id="input-last" accept="image/*" class="hidden">
                    <div id="content-last" class="flex flex-col items-center text-gray-500 pointer-events-none">
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
            const input = this.container.querySelector(`#input-${type}`);

            // 点击上传
            card.addEventListener('click', () => input.click());

            // 文件选择改变
            input.addEventListener('change', (e) => {
                if (e.target.files.length > 0) {
                    this.handleFile(type, e.target.files[0]);
                }
                input.value = ''; // 允许重复选择同名文件
            });

            // 拖拽上传支持
            card.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.stopPropagation();
                card.classList.add('border-[#6b6b6d]', 'bg-[#353538]', 'scale-105', 'rotate-0', 'translate-y-0');
            });

            card.addEventListener('dragleave', (e) => {
                e.preventDefault();
                e.stopPropagation();
                card.classList.remove('border-[#6b6b6d]', 'bg-[#353538]', 'scale-105', 'rotate-0', 'translate-y-0');
            });

            card.addEventListener('drop', (e) => {
                e.preventDefault();
                e.stopPropagation();
                card.classList.remove('border-[#6b6b6d]', 'bg-[#353538]', 'scale-105', 'rotate-0', 'translate-y-0');
                if (e.dataTransfer.files.length > 0) {
                    const file = e.dataTransfer.files[0];
                    if (file.type.startsWith('image/')) {
                        this.handleFile(type, file);
                    }
                }
            });
        });

        // 互换按钮事件
        this.container.querySelector('#btn-swap').addEventListener('click', () => this.swapFrames());
    }

    handleFile(type, file) {
        // 验证文件类型
        if (!file.type.startsWith('image/')) {
            console.warn(`FrameUploader: ${type} 帧只支持图片文件`);
            return;
        }

        this.frames[type] = file;

        // 清理旧的预览 URL
        if (this.previewUrls[type]) {
            URL.revokeObjectURL(this.previewUrls[type]);
        }
        this.previewUrls[type] = URL.createObjectURL(file);

        this.updateCardUI(type);

        // 通知状态更新
        if (typeof EventBus !== 'undefined') {
            EventBus.emit('frame:changed', { type, file, frames: this.getFrames() });
        }
    }

    updateCardUI(type) {
        const card = this.container.querySelector(`#card-${type}`);
        const content = this.container.querySelector(`#content-${type}`);

        if (this.previewUrls[type]) {
            card.style.backgroundImage = `url(${this.previewUrls[type]})`;
            card.classList.remove('border-dashed');
            card.classList.add('border-solid', 'border-[#00cae0]');
            content.style.display = 'none';
        } else {
            card.style.backgroundImage = 'none';
            card.classList.add('border-dashed');
            card.classList.remove('border-solid', 'border-[#00cae0]');
            content.style.display = 'flex';
        }
    }

    swapFrames() {
        // 交换文件和 URL
        [this.frames.first, this.frames.last] = [this.frames.last, this.frames.first];
        [this.previewUrls.first, this.previewUrls.last] = [this.previewUrls.last, this.previewUrls.first];

        this.updateCardUI('first');
        this.updateCardUI('last');

        // 通知状态更新
        if (typeof EventBus !== 'undefined') {
            EventBus.emit('frame:swapped', { frames: this.getFrames() });
        }
    }

    // 获取当前帧文件
    getFrames() {
        return {
            firstFrame: this.frames.first,
            lastFrame: this.frames.last
        };
    }

    // 检查是否已上传完整
    isComplete() {
        return this.frames.first !== null && this.frames.last !== null;
    }

    // 重置所有帧
    reset() {
        if (this.previewUrls.first) {
            URL.revokeObjectURL(this.previewUrls.first);
        }
        if (this.previewUrls.last) {
            URL.revokeObjectURL(this.previewUrls.last);
        }

        this.frames = { first: null, last: null };
        this.previewUrls = { first: null, last: null };

        this.updateCardUI('first');
        this.updateCardUI('last');
    }

    // 销毁组件
    destroy() {
        this.reset();
        if (this.container) {
            this.container.innerHTML = '';
        }
    }
}

// 挂载到全局
window.FrameUploader = FrameUploader;

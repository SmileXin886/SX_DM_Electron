/**
 * 编辑器标签同步模块 (editor_tag_sync.js)
 * =======================================
 * 职责：监听上传区文件删除事件，自动移除编辑区（#dreaminaPrompt）中对应的素材标签
 *
 * 【Electron 迁移说明】
 * - 旧版：监听 'bridge-ready' 事件（Qt WebChannel 特有）
 * - 新版：监听 'bridge:ready' 事件（api.js 触发）
 */

(function() {
    'use strict';

    const TAG_SELECTOR = '.ref-tag';
    var _initialized = false;
    var _listeningToFileRemoved = false;

    function init() {
        if (_initialized) return;
        _initialized = true;

        console.log('[EditorTagSync] 初始化编辑器标签同步模块');

        if (window.EventBus) {
            window.EventBus.on('file:removed', handleFileRemoved);
            _listeningToFileRemoved = true;
            console.log('[EditorTagSync] 已订阅 file:removed 事件');
        } else {
            console.warn('[EditorTagSync] EventBus 未就绪，等待...');
            // EventBus 由 api.js 初始化，等待其就绪
            var checkEventBusTimer = setInterval(function() {
                if (window.EventBus) {
                    clearInterval(checkEventBusTimer);
                    window.EventBus.on('file:removed', handleFileRemoved);
                    _listeningToFileRemoved = true;
                    console.log('[EditorTagSync] EventBus 就绪，已订阅 file:removed');
                }
            }, 100);

            // 最多等待 5 秒
            setTimeout(function() {
                clearInterval(checkEventBusTimer);
                if (!_listeningToFileRemoved) {
                    console.warn('[EditorTagSync] EventBus 未就绪，放弃订阅');
                }
            }, 5000);
        }
    }

    /**
     * 处理文件删除事件
     * @param {Object} deletedFileInfo - 被删除文件的信息，包含 path、name、url 等标识
     */
    function handleFileRemoved(deletedFileInfo) {
        console.log('[EditorTagSync] 收到文件删除事件', deletedFileInfo);

        var editor = document.getElementById('dreaminaPrompt');
        if (!editor) {
            console.warn('[EditorTagSync] 编辑区 #dreaminaPrompt 不存在');
            return;
        }

        var tags = editor.querySelectorAll(TAG_SELECTOR);
        if (tags.length === 0) return;

        var deletedPath = deletedFileInfo.path || '';
        var deletedName = deletedFileInfo.name || '';
        var deletedUrl = deletedFileInfo.url || '';

        // 使用 DocumentFragment 批量移除标签，避免频繁触发 reflow
        var tagsToRemove = [];
        var tagsToUpdate = [];

        for (var i = 0; i < tags.length; i++) {
            var tag = tags[i];
            var tagIndex = parseInt(tag.dataset.index, 10);
            var tagPath = tag.dataset.path || '';
            var tagName = tag.dataset.name || '';
            var tagUrl = tag.dataset.url || '';

            // 优先按路径/URL 精确匹配
            if (deletedPath && tagPath && tagPath === deletedPath) {
                tagsToRemove.push(tag);
                continue;
            }
            if (deletedUrl && tagUrl && tagUrl === deletedUrl) {
                tagsToRemove.push(tag);
                continue;
            }
            // 名称匹配
            if (deletedName && tagName && tagName === deletedName) {
                tagsToRemove.push(tag);
                continue;
            }
        }

        if (tagsToRemove.length > 0) {
            // 批量移除前先保存光标位置
            var selection = window.getSelection();
            var cursorRange = null;
            if (selection.rangeCount > 0) {
                var range = selection.getRangeAt(0);
                // 检查光标是否在即将被删除的标签内
                var cursorInRemovedTag = false;
                for (var r = 0; r < tagsToRemove.length; r++) {
                    if (tagsToRemove[r].contains(range.startContainer)) {
                        cursorInRemovedTag = true;
                        break;
                    }
                }
                if (cursorInRemovedTag) {
                    // 光标在即将删除的标签内，将其移到标签前
                    cursorRange = document.createRange();
                    cursorRange.setStartBefore(tagsToRemove[0]);
                    cursorRange.collapse(true);
                }
            }

            // 批量移除标签（触发一次 reflow）
            var fragment = document.createDocumentFragment();
            for (var j = 0; j < tagsToRemove.length; j++) {
                fragment.appendChild(tagsToRemove[j]);
            }
            fragment.innerHTML = ''; // DocumentFragment 不支持 innerHTML，直接清空

            // 移除标签
            for (var k = 0; k < tagsToRemove.length; k++) {
                tagsToRemove[k].remove();
            }

            // 恢复光标位置
            if (cursorRange) {
                selection.removeAllRanges();
                selection.addRange(cursorRange);
            }

            // 删除后重新对齐剩余标签（放在下一帧执行，避免阻塞）
            requestAnimationFrame(function() {
                _reindexTags(editor);
                editor.dispatchEvent(new Event('input', { bubbles: true }));
            });
        }
    }

    /**
     * 删除后重新对齐所有标签的 data-index
     * 与当前 AppState.uploadedFiles 保持顺序一致
     */
    function _reindexTags(editor) {
        var tags = Array.from(editor.querySelectorAll(TAG_SELECTOR));
        var currentFiles = (window.AppState && window.AppState.uploadedFiles) || [];
        var tagsToRemove = [];

        for (var i = 0; i < tags.length; i++) {
            var tag = tags[i];
            var tagPath = tag.dataset.path || '';
            var tagUrl = tag.dataset.url || '';
            var tagName = tag.dataset.name || '';

            // 在当前文件列表中找到对应文件的新 index
            var newIndex = -1;
            for (var j = 0; j < currentFiles.length; j++) {
                var f = currentFiles[j];
                if ((tagPath && f.path === tagPath) ||
                    (tagUrl && f.url === tagUrl) ||
                    (tagName && f.name === tagName)) {
                    newIndex = j;
                    break;
                }
            }

            if (newIndex >= 0) {
                tag.dataset.index = newIndex;
                // 同步更新显示的序号
                var nameSpan = tag.querySelector('.ref-name');
                if (nameSpan) {
                    var type = tag.dataset.type || 'file';
                    nameSpan.textContent = type.charAt(0).toUpperCase() + type.slice(1) + _getTypeCountForRebase(type, newIndex);
                }
            } else {
                // 文件已不在列表中，标记待移除
                tagsToRemove.push(tag);
            }
        }

        // 统一批量移除孤立标签
        for (var k = 0; k < tagsToRemove.length; k++) {
            tagsToRemove[k].remove();
        }
    }

    /**
     * 计算指定文件在其类型序列中的序号（用于 reindex）
     */
    function _getTypeCountForRebase(type, targetIndex) {
        var files = (window.AppState && window.AppState.uploadedFiles) || [];
        var count = 0;
        for (var i = 0; i <= targetIndex; i++) {
            if ((files[i] || {}).type === type) count++;
        }
        return count;
    }

    /**
     * 手动同步：根据当前文件列表清理编辑区中的过期标签
     */
    function syncWithFileList(currentFiles) {
        var editor = document.getElementById('dreaminaPrompt');
        if (!editor) return;

        var tags = editor.querySelectorAll(TAG_SELECTOR);
        if (tags.length === 0) return;

        var tagsToRemove = [];
        for (var j = 0; j < tags.length; j++) {
            var tag = tags[j];
            var tagPath = tag.dataset.path || '';
            var tagUrl = tag.dataset.url || '';
            var tagName = tag.dataset.name || '';

            // 在当前文件列表中查找是否存在该文件
            var found = false;
            for (var i = 0; i < currentFiles.length; i++) {
                var f = currentFiles[i];
                if ((tagPath && f.path === tagPath) ||
                    (tagUrl && f.url === tagUrl) ||
                    (tagName && f.name === tagName)) {
                    found = true;
                    // 同步更新 index 和序号
                    tag.dataset.index = i;
                    var type = tag.dataset.type || 'file';
                    var nameSpan = tag.querySelector('.ref-name');
                    if (nameSpan) {
                        nameSpan.textContent = type.charAt(0).toUpperCase() + type.slice(1) + _getTypeCountForRebase(type, i);
                    }
                    break;
                }
            }

            if (!found) {
                tagsToRemove.push(tag);
            }
        }

        if (tagsToRemove.length > 0) {
            for (var k = 0; k < tagsToRemove.length; k++) {
                tagsToRemove[k].remove();
            }
            editor.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }

    window.EditorTagSync = {
        init: init,
        handleFileRemoved: handleFileRemoved,
        syncWithFileList: syncWithFileList
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();

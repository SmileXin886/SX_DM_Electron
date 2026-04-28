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
     * @param {Object} deletedFileInfo - 被删除文件的信息，包含 path、name 等标识
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

        var tagsToRemove = [];

        for (var i = 0; i < tags.length; i++) {
            (function(tag) {
                var tagIndex = parseInt(tag.dataset.index, 10);
                var tagPath = tag.dataset.path || '';
                var tagName = tag.dataset.name || '';
                var tagUrl = tag.dataset.url || '';

                var deletedPath = deletedFileInfo.path || '';
                if (deletedPath && tagPath && tagPath === deletedPath) {
                    tagsToRemove.push(tag);
                    return;
                }

                var deletedName = deletedFileInfo.name || '';
                if (deletedName && tagName && tagName === deletedName) {
                    tagsToRemove.push(tag);
                    return;
                }

                if (deletedFileInfo.url && tagUrl && tagUrl === deletedFileInfo.url) {
                    tagsToRemove.push(tag);
                    return;
                }

                // 通过 index 匹配（如果无法通过路径/名称匹配）
                if (!deletedPath && !deletedName && !deletedFileInfo.url) {
                    if (!isNaN(tagIndex) && tagIndex === deletedFileInfo.index) {
                        tagsToRemove.push(tag);
                    }
                }
            })(tags[i]);
        }

        if (tagsToRemove.length > 0) {
            for (var j = 0; j < tagsToRemove.length; j++) {
                (function(tag) {
                    var selection = window.getSelection();
                    if (selection.rangeCount > 0) {
                        var range = selection.getRangeAt(0);
                        if (tag.contains(range.startContainer)) {
                            var newRange = document.createRange();
                            newRange.setStartBefore(tag);
                            newRange.collapse(true);
                            selection.removeAllRanges();
                            selection.addRange(newRange);
                        }
                    }
                    tag.remove();
                })(tagsToRemove[j]);
            }
            editor.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }

    /**
     * 手动同步：根据当前文件列表清理编辑区中的过期标签
     */
    function syncWithFileList(currentFiles) {
        var editor = document.getElementById('dreaminaPrompt');
        if (!editor) return;

        var tags = editor.querySelectorAll(TAG_SELECTOR);
        if (tags.length === 0) return;

        var validIndices = {};
        if (currentFiles) {
            for (var i = 0; i < currentFiles.length; i++) {
                validIndices[i] = true;
            }
        }

        var tagsToRemove = [];
        for (var j = 0; j < tags.length; j++) {
            var tagIndex = parseInt(tags[j].dataset.index, 10);
            if (isNaN(tagIndex) || !validIndices.hasOwnProperty(tagIndex)) {
                tagsToRemove.push(tags[j]);
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

/**
 * 工具函数库
 * 提供通用辅助函数
 */
const RegUtils = {

    esc(str) {
        if (str == null) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    },

    icon(name) {
        return RegIcons[name] || '';
    },
};

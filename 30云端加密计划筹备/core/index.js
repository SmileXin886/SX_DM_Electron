/**
 * core/ 模块包入口
 * Electron 主进程专用，提供账号管理和安全浏览器启动能力
 */
module.exports = {
    getAccountManager: require('./account_manager').getAccountManager,
    startSecureBrowser: require('./browser_launcher').startSecureBrowser,
    getActiveAccountIds: require('./browser_launcher').getActiveAccountIds,
};

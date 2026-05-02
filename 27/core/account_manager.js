/**
 * 账号管理模块
 * 只存加密的 .sxc 数据，永远不存明文 Cookie
 * 持久化到 accounts.json
 */
const fs = require('fs');
const path = require('path');
const { decryptSxc } = require('./decryptor');

class AccountManager {
    constructor() {
        this._dataFile = path.join(__dirname, '..', 'accounts.json');
        this._accounts = [];
        this._load();
    }

    _load() {
        try {
            if (fs.existsSync(this._dataFile)) {
                const data = JSON.parse(fs.readFileSync(this._dataFile, 'utf8'));
                this._accounts = Array.isArray(data) ? data : [];
            }
        } catch {
            this._accounts = [];
        }
    }

    _save() {
        fs.writeFileSync(this._dataFile, JSON.stringify(this._accounts, null, 2), 'utf8');
    }

    /**
     * 导入 .sxc 文件（解密校验后加密存储）
     * @param {Buffer} sxcFileData - .sxc 文件二进制
     * @param {string} accountName - 账号显示名称
     * @returns {Promise<Object>} 账号信息（不含敏感数据）
     */
    async importAccountFromSxc(sxcFileData, accountName) {
        // 先解密验证文件有效性
        await decryptSxc(sxcFileData);

        const timestamp = Date.now();
        const randomPart = Math.random().toString(36).slice(2, 8);
        const accountId = `${timestamp.toString(16)}_${randomPart}`;

        const account = {
            id: accountId,
            name: accountName,
            sxcDataB64: Buffer.from(sxcFileData).toString('base64'),
            createdAt: timestamp,
            updatedAt: timestamp,
        };

        this._accounts.unshift(account);
        this._save();

        // 内存清零
        if (sxcFileData.fill) sxcFileData.fill(0);

        return {
            id: accountId,
            name: accountName,
            createdAt: timestamp,
        };
    }

    /**
     * 获取所有账号列表（不含敏感数据）
     */
    getAllAccounts() {
        return this._accounts
            .map(a => ({
                id: a.id,
                name: a.name,
                createdAt: a.createdAt,
            }))
            .sort((a, b) => b.createdAt - a.createdAt);
    }

    /**
     * 获取账号明文凭证，内存解密，用完即清
     * @param {string} accountId
     * @returns {Promise<Object>}
     */
    async getAccountCredentials(accountId) {
        const account = this._accounts.find(a => a.id === accountId);
        if (!account) throw new Error('账号不存在');

        const sxcData = Buffer.from(account.sxcDataB64, 'base64');
        const credentials = await decryptSxc(sxcData);

        sxcData.fill(0);
        return credentials;
    }

    /**
     * 删除账号
     * @param {string} accountId
     * @returns {boolean}
     */
    deleteAccount(accountId) {
        const originalLen = this._accounts.length;
        this._accounts = this._accounts.filter(a => a.id !== accountId);
        if (this._accounts.length !== originalLen) {
            this._save();
            return true;
        }
        return false;
    }
}

// 单例
let _instance = null;
function getAccountManager() {
    if (!_instance) _instance = new AccountManager();
    return _instance;
}

module.exports = { getAccountManager };

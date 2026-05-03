/**
 * 账号管理模块
 * 只存加密的 .sxc 数据，永远不存明文 Cookie
 * 持久化到 accounts.json，和跨平台 userData 目录完全对齐
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { decryptSxc } = require('./decryptor');

class AccountManager {
    constructor() {
        this._userDataPath = app.getPath('userData');
        this._dataFile = path.join(this._userDataPath, 'accounts.json');
        // 改名成 avatar_cache，再也不会和Electron的Cache重名了！
        this._cacheDir = path.join(this._userDataPath, 'avatar_cache');
        this._accounts = [];

        // 自动创建缓存目录，不存在的话自动建
        if (!fs.existsSync(this._cacheDir)) {
            fs.mkdirSync(this._cacheDir, { recursive: true });
        }

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
     */
    async importAccountFromSxc(sxcFileData, accountName) {
        await decryptSxc(sxcFileData);

        const timestamp = Date.now();
        const randomPart = Math.random().toString(36).slice(2, 8);
        const accountId = `${timestamp.toString(16)}_${randomPart}`;

        const account = {
            id: accountId,
            name: accountName,
            sxcDataB64: Buffer.from(sxcFileData).toString('base64'),
            // 新增：默认值，兼容旧数据
            nickname: accountName,
            avatarPath: null,
            createdAt: timestamp,
            updatedAt: timestamp,
        };

        this._accounts.unshift(account);
        this._save();

        if (sxcFileData.fill) sxcFileData.fill(0);

        return {
            id: accountId,
            name: accountName,
            createdAt: timestamp,
        };
    }

    // ==================== 新增：更新账号的用户信息（昵称、头像） ====================
    updateAccountUserInfo(accountId, nickname, avatarPath) {
        const account = this._accounts.find(a => a.id === accountId);
        if (account) {
            account.nickname = nickname;
            account.avatarPath = avatarPath;
            account.updatedAt = Date.now();
            this._save();
        }
    }

    /**
     * 获取所有账号列表（不含敏感数据，按物理顺序返回）
     */
    getAllAccounts() {
        return this._accounts
            .map(a => ({
                id: a.id,
                name: a.name,
                nickname: a.nickname || a.name,
                avatarPath: a.avatarPath,
                createdAt: a.createdAt,
            }));
    }

    /**
     * 获取账号明文凭证，内存解密，用完即清
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

    /**
     * 重新排序账号（按传入的 orderedIds 数组调整物理顺序）
     */
    reorderAccounts(orderedIds) {
        if (!Array.isArray(orderedIds)) return;
        const idSet = new Set(orderedIds);
        const reordered = [];
        for (const id of orderedIds) {
            const acc = this._accounts.find(a => a.id === id);
            if (acc) reordered.push(acc);
        }
        const missed = this._accounts.filter(a => !idSet.has(a.id));
        this._accounts = [...reordered, ...missed];
        this._save();
    }
}

// 单例
let _instance = null;
function getAccountManager() {
    if (!_instance) _instance = new AccountManager();
    return _instance;
}

module.exports = { getAccountManager };

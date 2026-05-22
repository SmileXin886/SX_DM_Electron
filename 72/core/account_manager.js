/**
 * 账号管理模块
 * 只存加密的 .sxc 数据，永远不存明文 Cookie
 * 持久化到 accounts.json，和跨平台 userData 目录完全对齐
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { decryptSxc } = require('./decryptor');
const { encryptForMachine, decryptForMachine } = require('./local_crypto');
const { authenticateWithCloud, verifyCloudStatus } = require('./cloud_auth');

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

    /**
     * 云端验证导入（纯激活码版 + 本地硬件锁）
     */
    async importAccountFromCloud(licenseKey) {
        // 【新增】：在请求云端前，先检查本地是不是已经导入过这个激活码了
        const exists = this._accounts.find(a => a.licenseKey === licenseKey);
        if (exists) {
            throw new Error('该账号已验证，请勿重复添加！');
        }

        const authResult = await authenticateWithCloud(licenseKey);

        const timestamp = Date.now();
        const accountId = `cloud_${timestamp.toString(16)}_${Math.random().toString(36).slice(2, 8)}`;

        const lockedData = encryptForMachine(authResult.credentials);

        const account = {
            id: accountId,
            name: `云端授权_${licenseKey.slice(-4)}`,
            nickname: `云端授权_${licenseKey.slice(-4)}`,
            avatarPath: null,
            createdAt: timestamp,
            updatedAt: timestamp,
            isCloud: true,
            expireAt: authResult.expireAt,
            machineLockedData: lockedData,
            licenseKey: licenseKey, // 【新增】：把激活码原文存下来，作为排重标识
        };

        this._accounts.unshift(account);
        this._save();

        return { id: accountId, name: account.name, createdAt: timestamp };
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
     * 根据 accountId 获取账号的公开信息（昵称、头像路径）
     * @param {string} accountId
     * @returns {{ nickname: string, avatarPath: string|null }}
     */
    getAccountInfo(accountId) {
        const account = this._accounts.find(a => a.id === accountId);
        if (!account) return { nickname: null, avatarPath: null };
        return { nickname: account.nickname || account.name, avatarPath: account.avatarPath || null };
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
                isCloud: !!a.isCloud,
                expireAt: a.expireAt || null,
            }));
    }

    /**
     * 获取账号明文凭证，内存解密，用完即清
     */
    async getAccountCredentials(accountId) {
        const account = this._accounts.find(a => a.id === accountId);
        if (!account) throw new Error('账号不存在');

        // 云端账号：使用本地硬件锁解密
        if (account.isCloud && account.machineLockedData) {

            // 【核心防御】：抛弃本地时间验证，启动前必须强制经过云端查岗！
            if (account.licenseKey) {
                try {
                    const status = await verifyCloudStatus(account.licenseKey);

                    // 如果明确返回了过期/被拉黑，才执行删除
                    if (status.valid === false && status.reason === 'EXPIRED') {
                        account.machineLockedData = null;
                        this._save();
                        this.deleteAccount(accountId);
                        throw new Error('云端登入授权已失效 (本地账号信息已自动清理)');
                    }

                    // 如果 valid 是 false，但不是因为过期（比如网络超时、并发限流等），只报错不删号！
                    if (!status.valid) {
                        throw new Error('云端验证请求失败，请稍后重试或检查网络状态！');
                    }
                } catch (error) {
                    // 捕获并发导致的 fetch timeout 或断网错误
                    if (error.message.includes('云端登入授权已失效')) {
                        throw error; // 真正的失效，往上抛出
                    } else {
                        // 网络级别的错误，坚决不能删号！
                        throw new Error(`云端验证异常，请不要同时启动过多账号。详细错误: ${error.message}`);
                    }
                }
            } else {
                 // 异常状态：云端账号却没有 licenseKey，直接销毁
                 this.deleteAccount(accountId);
                 throw new Error('本地授权数据异常，已强制清理。');
            }

            // 云端放行，且本地硬件锁匹配，才允许解密
            return decryptForMachine(account.machineLockedData);
        }

        // 本地旧账号 (sxc)：使用原来的解密方式
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

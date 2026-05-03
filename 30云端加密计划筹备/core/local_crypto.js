/**
 * 本地硬件级加密锁 (local_crypto.js)
 * ====================================
 * 职责：基于当前电脑的主板/CPU序列号生成唯一密钥，
 * 对数据进行 AES-256-GCM 加密。防止 accounts.json 被转移到其他电脑。
 */
const crypto = require('crypto');
const { machineIdSync } = require('node-machine-id');

/**
 * 获取当前电脑的专属密钥（32字节 = 256位）
 * 格式：SHA-256(MachineID + 盐值)
 */
function getMachineKey() {
    const machineId = machineIdSync();
    return crypto.createHash('sha256').update(machineId + '_SMILEXIN_HARDWARE_LOCK').digest();
}

/**
 * 用硬件锁加密数据
 * @param {Object} dataObj - 要加密的 JSON 对象
 * @returns {string} 加密后的 JSON 字符串 (包含 iv, data, tag)
 */
function encryptForMachine(dataObj) {
    const key = getMachineKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

    let encrypted = cipher.update(JSON.stringify(dataObj), 'utf8', 'base64');
    encrypted += cipher.final('base64');
    const authTag = cipher.getAuthTag().toString('base64');

    return JSON.stringify({
        iv: iv.toString('base64'),
        data: encrypted,
        tag: authTag,
    });
}

/**
 * 用硬件锁解密数据
 * @param {string} encryptedJsonStr - encryptForMachine 返回的字符串
 * @returns {Object} 原始 JSON 对象
 */
function decryptForMachine(encryptedJsonStr) {
    const key = getMachineKey();
    const { iv, data, tag } = JSON.parse(encryptedJsonStr);

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));

    let decrypted;
    try {
        decrypted = decipher.update(data, 'base64', 'utf8');
        decrypted += decipher.final('utf8');
    } catch (e) {
        throw new Error('本地硬件锁解密失败，该存档可能不属于当前电脑或已被篡改。');
    }

    return JSON.parse(decrypted);
}

module.exports = { encryptForMachine, decryptForMachine };

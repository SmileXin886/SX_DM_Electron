/**
 * .sxc 文件解密模块
 * Node.js (Electron 主进程) 专用，使用 Node 内置 crypto 模拟 Web Crypto API
 * 算法：AES-256-GCM，和 Chrome 扩展端完全一致
 * 全在内存执行，绝不落盘
 */

// Node.js 原生 crypto（Electron 主进程环境保证可用）
const { webcrypto } = require('crypto');
const crypto = webcrypto;

// 模拟浏览器端的 atob/btoa
function atob(str) {
    return Buffer.from(str, 'base64').toString('binary');
}
function btoa(str) {
    return Buffer.from(str, 'binary').toString('base64');
}

/**
 * 获取 AES-256 解密密钥
 * 和扩展端 JS 完全一样的密钥，打乱顺序防反编译
 */
async function _getMasterKey() {
    const part3 = btoa('wxaczxah');
    const part1 = btoa('sxcccfgh');
    const part4 = btoa('s1172581');
    const part2 = btoa('sscgxdsg');
    const keyStr = atob(part1) + atob(part2) + atob(part3) + atob(part4);
    return new TextEncoder().encode(keyStr);
}

/**
 * 解密 .sxc 加密文件
 * @param {Buffer|Uint8Array} encryptedData - .sxc 文件二进制内容
 * @returns {Promise<Object>} 解密后的凭证（cookies, envFingerprint 等）
 */
async function decryptSxc(encryptedData) {
    // 统一转为 Uint8Array
    const raw = Buffer.isBuffer(encryptedData)
        ? new Uint8Array(encryptedData)
        : encryptedData;

    // 1. 解析头部
    const headerBytes = new Uint8Array([0x53, 0x58, 0x43, 0x5f, 0x45, 0x4e, 0x43, 0x3a]); // "SXC_ENC:"
    const headerMatches = raw.length > 8 &&
        headerBytes.every((b, i) => raw[i] === b);

    if (!headerMatches) {
        throw new Error("无效的 .sxc 加密文件");
    }

    // 2. 解码 Base64 部分
    const b64Str = Buffer.from(raw.slice(8)).toString('utf8');
    const encrypted = Uint8Array.from(Buffer.from(b64Str, 'base64'));

    // 3. 拆分 IV（前 12 字节）和密文
    const iv = encrypted.slice(0, 12);
    const ciphertext = encrypted.slice(12);

    // 4. AES-256-GCM 解密
    const key = await _getMasterKey();
    const aesGcm = await crypto.subtle.importKey(
        'raw', key, { name: 'AES-GCM' }, false, ['decrypt']
    );

    let plaintext;
    try {
        plaintext = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: iv },
            aesGcm,
            ciphertext
        );
    } finally {
        // 内存清零
        key.fill(0);
        iv.fill(0);
        ciphertext.fill(0);
    }

    // 5. 解析 JSON
    const credentials = JSON.parse(Buffer.from(plaintext).toString('utf8'));

    return credentials;
}

module.exports = { decryptSxc };

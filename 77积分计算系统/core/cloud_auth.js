/**
 * 云端动态授权中心 (cloud_auth.js)
 * ====================================
 * 职责：与 Cloudflare Worker 进行防抓包通信，获取真实 Cookie 数据
 */
const { webcrypto } = require('crypto');
const crypto = webcrypto;

// 这里填入你之前绑定的自定义域名
const CLOUDFLARE_API_URL = 'https://jm.cloud-sync-test.top/api/auth';

function arrayBufferToBase64(buffer) {
    return Buffer.from(buffer).toString('base64');
}

/**
 * 通过激活码向云端索要数据并解密
 * @param {string} licenseKey - 用户输入的激活码
 * @returns {Promise<Object>} 凭证数据 + 过期时间 + 激活码
 */
async function authenticateWithCloud(licenseKey) {
    const { getMachineId } = require('./hw_fingerprint');
    const machineId = getMachineId();

    // 1. 生成临时公私钥对 (防中间人抓包)
    const tempKeyPair = await crypto.subtle.generateKey(
        { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
        true,
        ['encrypt', 'decrypt']
    );

    const tempPubKeyBuffer = await crypto.subtle.exportKey('spki', tempKeyPair.publicKey);
    // 直接发送纯粹的 Base64 字符串，不加 Pem 头尾，不加换行符
    const tempPublicKeyBase64 = arrayBufferToBase64(tempPubKeyBuffer);

    // 2. 发起请求
    const response = await fetch(CLOUDFLARE_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            licenseKey: licenseKey,
            machineId: machineId,
            tempPublicKeyPem: tempPublicKeyBase64, // 名字保持不变，但内容改为纯 Base64
        }),
    });

    const text = await response.text();
    let result;
    try {
        result = JSON.parse(text);
    } catch (err) {
        throw new Error(`Network proxy error or intercepted (HTTP ${response.status}).`);
    }

    if (!response.ok || !result.success) {
        throw new Error(result.error || '云端拒绝授权');
    }

    // 3. 用临时私钥解开 AES 钥匙
    const secureKeyBytes = Buffer.from(result.secureKey, 'base64');
    const rawAesKey = await crypto.subtle.decrypt(
        { name: 'RSA-OAEP' },
        tempKeyPair.privateKey,
        secureKeyBytes
    );

    // 4. 用 AES 钥匙解开 Cookie 数据
    const aesCryptoKey = await crypto.subtle.importKey(
        'raw',
        rawAesKey,
        { name: 'AES-GCM' },
        false,
        ['decrypt']
    );
    const ivBytes = Buffer.from(result.iv, 'base64');
    const encDataBytes = Buffer.from(result.encData, 'base64');

    const plaintextBuffer = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: ivBytes },
        aesCryptoKey,
        encDataBytes
    );

    return {
        credentials: JSON.parse(Buffer.from(plaintextBuffer).toString('utf8')),
        expireAt: result.expireAt,
        licenseKey: licenseKey,
    };
}

/**
 * 云端查岗：实时验证激活码是否仍然有效
 * @param {string} licenseKey - 要验证的激活码
 * @returns {Promise<Object>} { valid: boolean, reason?: string }
 */
async function verifyCloudStatus(licenseKey) {
    const { getMachineId } = require('./hw_fingerprint');
    const machineId = getMachineId();

    // 修复：将请求的 URL 改为直接调用 '/api/auth/check'
    // 由于 CLOUDFLARE_API_URL 是 'https://jm.cloud-sync-test.top/api/auth'
    // 我们需要用基础域名拼接，或者直接写死完整的 URL
    const checkUrl = 'https://jm.cloud-sync-test.top/api/auth/check';

    try {
        const response = await fetch(checkUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                licenseKey: licenseKey,
                machineId: machineId,
            }),
        });

        const text = await response.text();
        let result;
        try {
            result = JSON.parse(text);
        } catch (err) {
            throw new Error(`Network proxy error or intercepted (HTTP ${response.status}).`);
        }

        // 兼容后端的返回格式 { valid: true/false, reason: "..." }
        if (!response.ok || !result.valid) {
            return { valid: false, reason: result.reason || '授权已失效' };
        }

        return { valid: true };
    } catch (e) {
         // 网络异常等情况的兜底
         return { valid: false, reason: '无法连接验证服务器' };
    }
}

/**
 * 软件启动强验证：向云端验证软件激活码，并获取内存核心凭证
 * @param {string} licenseKey - 用户输入的软件激活码
 * @returns {Promise<Object>} { success: boolean, payload?: Object, serverTime?: number, error?: string }
 */
async function verifySoftwareLicense(licenseKey) {
    const { getMachineId } = require('./hw_fingerprint');
    const machineId = getMachineId();

    try {
        // 1. 生成一次性临时 RSA 公私钥对（防抓包重放）
        const tempKeyPair = await crypto.subtle.generateKey(
            { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
            true,
            ['encrypt', 'decrypt']
        );
        const tempPubKeyBuffer = await crypto.subtle.exportKey('spki', tempKeyPair.publicKey);
        const tempPublicKeyBase64 = arrayBufferToBase64(tempPubKeyBuffer);

        // 2. 发起验证请求 (调用全新独立的软件激活码接口)
        const verifyUrl = 'https://jm.cloud-sync-test.top/api/client/verify-software';
        const response = await fetch(verifyUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                licenseKey: licenseKey,
                machineId: machineId,
                tempPublicKeyPem: tempPublicKeyBase64
            }),
        });

        const text = await response.text();
        let result;
        try {
            result = JSON.parse(text);
        } catch (err) {
            throw new Error(`Network proxy error or intercepted (HTTP ${response.status}).`);
        }

        // 如果云端拦截（设备不匹配、已销毁、过期等）
        if (!response.ok || !result.success) {
            return { success: false, error: result.error || '验证被拒绝' };
        }

        // 3. 验证通过，使用本地临时私钥解密云端下发的"核心凭证(Secure Payload)"
        const encBytes = Buffer.from(result.secureData, 'base64');
        const decryptedBuffer = await crypto.subtle.decrypt(
            { name: 'RSA-OAEP' },
            tempKeyPair.privateKey,
            encBytes
        );

        const payloadStr = Buffer.from(decryptedBuffer).toString('utf8');
        const payload = JSON.parse(payloadStr);

        // 4. 同步服务器时间偏移量（防止用户修改本地时间作弊）
        // 假设后端在 result.serverTime 返回服务器当前的 Unix 毫秒时间戳
        const serverTime = result.serverTime || Date.now();
        global.TIME_OFFSET = serverTime - Date.now();

        return { success: true, payload: payload, serverTime: serverTime };
    } catch (e) {
        return { success: false, error: '安全连接失败: ' + e.message };
    }
}

module.exports = { authenticateWithCloud, verifyCloudStatus, verifySoftwareLicense };

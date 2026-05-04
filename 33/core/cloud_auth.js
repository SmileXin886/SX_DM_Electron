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
    const { machineIdSync } = require('node-machine-id');
    const machineId = machineIdSync();

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

    const result = await response.json();
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
    const { machineIdSync } = require('node-machine-id');
    const machineId = machineIdSync();

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

        const result = await response.json();

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

module.exports = { authenticateWithCloud, verifyCloudStatus };

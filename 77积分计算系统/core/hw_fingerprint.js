/**
 * hw_fingerprint.js - 跨平台硬件指纹采集模块
 * ==========================================
 * 职责：完全自主采集硬件特征码，替代 node-machine-id，
 *       防止第三方库被逆向分析或投毒。
 *
 * 采集策略：
 *   Windows → PowerShell (Get-CimInstance Win32_ComputerSystemProduct.UUID)
 *            → 备选 WMIC
 *            → 兜底 networkInterfaces 物理网卡 MAC
 *   Mac     → ioreg IOPlatformUUID
 *   其他    → networkInterfaces 物理网卡 MAC
 *
 * 最终输出：SHA-256(硬件特征码 + 盐值) 的纯 16 进制字符串
 */
const { execSync } = require('child_process');
const crypto = require('crypto');
const os = require('os');

/** 固定盐值：与各调用方的盐独立，进一步对抗彩虹表 */
const GLOBAL_SALT = 'SMILEXIN_SECURE_HW_V1';

/** 虚拟网卡特征词（用于排除） */
const VIRTUAL_KEYWORDS = ['VMware', 'Virtual', 'Hyper-V', 'vEthernet', 'VirtualBox', ' Loop '];

/**
 * 同步执行命令并返回 stdout 字符串（去除首尾空白）
 * @param {string} cmd - 要执行的命令
 * @param {string[]} [encoding] - 编码，默认 'utf8'
 * @returns {string|null} 成功返回标准输出字符串，失败返回 null
 */
function execCmd(cmd, encoding = 'utf8') {
    try {
        return execSync(cmd, { encoding, windowsHide: true, timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch (_) {
        return null;
    }
}

/**
 * 获取主板/BIOS UUID（Windows 首选方案）
 * @returns {string|null}
 */
function getBiosUuid() {
    // 方法 1：PowerShell Get-CimInstance（Win8+ 推荐，权限要求低）
    let result = execCmd(
        'powershell.exe -NoProfile -Command "(Get-CimInstance -Class Win32_ComputerSystemProduct).UUID"'
    );
    if (result && /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i.test(result)) {
        return result.toUpperCase().replace(/-/g, '');
    }

    // 方法 2：WMIC（兼容性更好，Win7 起可用）
    result = execCmd('wmic csproduct get uuid');
    if (result) {
        const match = result.match(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/im);
        if (match) {
            return match[0].replace(/-/g, '').toUpperCase();
        }
    }

    return null;
}

/**
 * 获取 Mac 硬件 UUID
 * @returns {string|null}
 */
function getMacUUID() {
    // ioreg -rd1 输出单行，提取 IOPlatformUUID value
    const raw = execCmd('ioreg -rd1 -c IOPlatformExpertDevice');
    if (!raw) return null;
    const match = raw.match(/IOPlatformUUID["\s]+=\s+["']?([0-9A-F-]{36})/i);
    if (match) {
        return match[1].replace(/-/g, '').toUpperCase();
    }
    return null;
}

/**
 * 获取第一个物理网卡的 MAC 地址（跨平台兜底方案）
 * @returns {string|null}
 */
function getPhysicalMac() {
    const ifaces = os.networkInterfaces();
    for (const [, addrs] of Object.entries(ifaces)) {
        if (!addrs) continue;
        const name = Object.keys(ifaces).find(k => ifaces[k] === addrs) || '';
        // 跳过虚拟网卡
        if (VIRTUAL_KEYWORDS.some(kw => name.includes(kw))) continue;

        for (const addr of addrs) {
            if (addr.mac && addr.mac !== '00:00:00:00:00:00' && !addr.internal) {
                return addr.mac.replace(/:/g, '').toUpperCase();
            }
        }
    }
    return null;
}

/**
 * 获取原始硬件特征码（各平台专属）
 * @returns {string}
 */
function getRawHardwareId() {
    const platform = process.platform;

    let raw = null;

    if (platform === 'win32') {
        raw = getBiosUuid();
    } else if (platform === 'darwin') {
        raw = getMacUUID();
    }

    // 任何方式失败，兜底到物理网卡 MAC
    if (!raw) {
        raw = getPhysicalMac();
    }

    // 极端情况：连 MAC 都拿不到，使用主机名 + CPU 核心数 + 内存总量拼接
    if (!raw) {
        raw = [
            os.hostname(),
            os.cpus().length,
            Math.round(os.totalmem() / 1024 / 1024),
        ].join('|');
    }

    return raw;
}

/**
 * 对原始硬件码进行清理：只保留字母数字 → SHA-256 → 十六进制
 * @param {string} raw - 原始硬件特征字符串
 * @returns {string} 纯 16 进制机器指纹（64 字符）
 */
function hashToMachineId(raw) {
    const cleaned = String(raw).replace(/[^A-Za-z0-9]/g, '');
    return crypto
        .createHash('sha256')
        .update(cleaned + GLOBAL_SALT, 'utf8')
        .digest('hex');
}

/**
 * 【对外唯一出口】获取当前设备的唯一机器指纹
 * 同步执行，无网络依赖，无第三方库依赖
 * @returns {string} 64 位 16 进制 SHA-256 字符串
 */
function getMachineId() {
    const raw = getRawHardwareId();
    return hashToMachineId(raw);
}

module.exports = { getMachineId };

# -*- coding: utf-8 -*-
"""
.sxc 文件解密模块
和 JS 端 AES-256-GCM 算法完全兼容，同一个密钥
解密全在内存，绝不落盘
"""
import base64
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def _get_master_key() -> bytes:
    """和你 JS 端完全一样的密钥，打乱顺序防反编译"""
    part3 = b'wxaczxah'
    part1 = b'sxcccfgh'
    part4 = b's1172581'
    part2 = b'sscgxdsg'
    key_str = part1 + part2 + part3 + part4
    return key_str


def decrypt_sxc(encrypted_data: bytes) -> dict:
    """
    解密 .sxc 文件，内存中执行
    :param encrypted_data: .sxc 文件的二进制内容
    :return: 解密后的凭证 JSON（包含 cookies、envFingerprint）
    """
    header = b'SXC_ENC:'
    if not encrypted_data.startswith(header):
        raise ValueError("无效的 .sxc 加密文件")

    encrypted_b64 = encrypted_data[len(header):].decode('utf-8')
    encrypted = base64.b64decode(encrypted_b64)

    iv = encrypted[:12]
    ciphertext = encrypted[12:]

    key = _get_master_key()
    aesgcm = AESGCM(key)

    try:
        plaintext = aesgcm.decrypt(iv, ciphertext, associated_data=None)
    finally:
        del key, iv, ciphertext, encrypted_b64, encrypted

    import json
    try:
        credentials = json.loads(plaintext.decode('utf-8'))
    finally:
        del plaintext

    return credentials


def wipe_memory(obj):
    """尝试清零对象内存引用（降低残留时间，不能保证完全）"""
    try:
        if isinstance(obj, dict):
            for v in obj.values():
                wipe_memory(v)
            obj.clear()
        elif isinstance(obj, list):
            for v in obj:
                wipe_memory(v)
            obj.clear()
        elif isinstance(obj, bytes):
            for i in range(len(obj)):
                obj[i] = 0
    except Exception:
        pass

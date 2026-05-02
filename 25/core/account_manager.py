# -*- coding: utf-8 -*-
"""
账号管理模块
负责加密存储账号、读取账号，和 preset_manager 逻辑对齐
存储的是加密后的 .sxc 原始数据，永远不存明文 Cookie
"""
import base64
import json
import random
import string
import threading
import time
from pathlib import Path
from .decryptor import decrypt_sxc


class AccountManager:
    _instance = None
    _lock = threading.Lock()

    def __new__(cls):
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
                    cls._instance._initialized = False
        return cls._instance

    def __init__(self):
        if self._initialized:
            return
        self._data_file = self._get_data_file_path()
        self._accounts = []
        self._data_lock = threading.Lock()
        self._load()
        self._initialized = True

    def _get_data_file_path(self) -> Path:
        module_dir = Path(__file__).parent.resolve()
        return module_dir.parent / "accounts.json"

    def _load(self):
        with self._data_lock:
            if self._data_file.exists():
                try:
                    with open(self._data_file, "r", encoding="utf-8") as f:
                        data = json.load(f)
                        self._accounts = data if isinstance(data, list) else []
                except (json.JSONDecodeError, IOError):
                    self._accounts = []
            else:
                self._accounts = []

    def _save(self):
        with self._data_lock:
            with open(self._data_file, "w", encoding="utf-8") as f:
                json.dump(self._accounts, f, ensure_ascii=False, indent=2)

    def import_account_from_sxc(self, sxc_file_data: bytes, account_name: str) -> dict:
        """
        导入 .sxc 文件，解密校验后加密存储
        :param sxc_file_data: .sxc 文件二进制
        :param account_name: 账号显示名称
        :return: 账号信息（不含敏感数据）
        """
        credentials = decrypt_sxc(sxc_file_data)

        timestamp = int(time.time() * 1000)
        random_part = ''.join(random.choices(string.ascii_lowercase + string.digits, k=6))
        account_id = f"{timestamp:x}_{random_part}"

        account = {
            "id": account_id,
            "name": account_name,
            "sxc_data_b64": base64.b64encode(sxc_file_data).decode('utf-8'),
            "createdAt": timestamp,
            "updatedAt": timestamp
        }

        with self._data_lock:
            self._accounts.insert(0, account)
        self._save()

        del credentials
        return {
            "id": account_id,
            "name": account_name,
            "createdAt": timestamp
        }

    def get_all_accounts(self) -> list:
        """获取所有账号列表（不含敏感数据）"""
        with self._data_lock:
            return sorted([
                {"id": a["id"], "name": a["name"], "createdAt": a["createdAt"]}
                for a in self._accounts
            ], key=lambda x: x["createdAt"], reverse=True)

    def get_account_credentials(self, account_id: str) -> dict:
        """
        获取账号的明文凭证，内存解密，用完立即清
        :param account_id: 账号 ID
        :return: 解密后的凭证
        """
        with self._data_lock:
            for a in self._accounts:
                if a["id"] == account_id:
                    sxc_data = base64.b64decode(a["sxc_data_b64"])
                    credentials = decrypt_sxc(sxc_data)
                    del sxc_data
                    return credentials
        raise ValueError("账号不存在")

    def delete_account(self, account_id: str) -> bool:
        """删除账号"""
        with self._data_lock:
            original_len = len(self._accounts)
            self._accounts = [a for a in self._accounts if a["id"] != account_id]
            if len(self._accounts) == original_len:
                return False
        self._save()
        return True


_account_manager_instance = None
_account_manager_lock = threading.Lock()


def get_account_manager() -> AccountManager:
    global _account_manager_instance
    if _account_manager_instance is None:
        with _account_manager_lock:
            if _account_manager_instance is None:
                _account_manager_instance = AccountManager()
    return _account_manager_instance

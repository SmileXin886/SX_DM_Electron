# -*- coding: utf-8 -*-
"""
Dreamina Toolkit - 预设管理器模块
负责预设数据的 CRUD 操作及 presets.json 文件的持久化管理

预设数据结构：
{
    "id": "abc123",                    # 唯一标识符
    "name": "预设A",                   # 预设名称
    "settings": {                      # 抓取的页面配置
        "pageType": "video",
        "toolType": "AI Video",
        "model": "Seedance",
        "referenceMode": "image",
        "duration": "5s",
        "aspectRatio": "16:9",
        "quality": "1080P"
    },
    "textContent": "视频描述文字",     # 提示词内容
    "imageURIs": [],                   # 图片引用 URI 列表
    "file_path": "D:/assets/1.mp4",    # 素材文件绝对路径
    "createdAt": 1704067200000,        # 创建时间戳
    "updatedAt": 1704067200000        # 更新时间戳
}
"""

import json
import logging
import os
import threading
from datetime import datetime
from pathlib import Path
from typing import List, Optional, Dict, Any

logger = logging.getLogger("SX_DM.preset_manager")


class PresetManager:
    """
    预设数据管理器
    采用线程安全的单例模式，确保 presets.json 的并发读写安全
    """

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
        self._presets: List[Dict[str, Any]] = []
        self._data_lock = threading.Lock()
        self._load()
        self._initialized = True

        logger.info(f"[PresetManager] 初始化完成，数据文件: {self._data_file}")

    def _get_data_file_path(self) -> Path:
        """获取数据文件路径（位于 SX_DM 目录下）"""
        module_dir = Path(__file__).parent.resolve()
        return module_dir / "presets.json"

    # ==================== 数据持久化 ====================

    def _load(self):
        """从磁盘加载预设数据"""
        with self._data_lock:
            if self._data_file.exists():
                try:
                    with open(self._data_file, "r", encoding="utf-8") as f:
                        data = json.load(f)
                        self._presets = data if isinstance(data, list) else []
                    logger.info(f"[PresetManager] 加载了 {len(self._presets)} 个预设")
                except json.JSONDecodeError as e:
                    logger.error(f"[PresetManager] JSON 解析失败: {e}，将创建新文件")
                    self._presets = []
                except Exception as e:
                    logger.error(f"[PresetManager] 加载失败: {e}")
                    self._presets = []
            else:
                logger.info("[PresetManager] 数据文件不存在，将创建新文件")
                self._presets = []

    def _save(self):
        """将预设数据保存到磁盘"""
        with self._data_lock:
            try:
                with open(self._data_file, "w", encoding="utf-8") as f:
                    json.dump(self._presets, f, ensure_ascii=False, indent=2)
                logger.debug(f"[PresetManager] 已保存 {len(self._presets)} 个预设到磁盘")
            except Exception as e:
                logger.error(f"[PresetManager] 保存失败: {e}")
                raise

    # ==================== CRUD 操作 ====================

    def get_all(self) -> List[Dict[str, Any]]:
        """
        获取所有预设列表（按创建时间倒序）

        Returns:
            预设列表
        """
        with self._data_lock:
            return sorted(self._presets, key=lambda x: x.get("createdAt", 0), reverse=True)

    def get_by_id(self, preset_id: str) -> Optional[Dict[str, Any]]:
        """
        根据 ID 获取单个预设

        Args:
            preset_id: 预设唯一标识

        Returns:
            预设数据或 None
        """
        with self._data_lock:
            for preset in self._presets:
                if preset.get("id") == preset_id:
                    return preset.copy()
            return None

    def create(self, name: str, settings: Dict[str, Any], text_content: str = "",
               image_uris: List[str] = None, file_path: str = "") -> Dict[str, Any]:
        """
        创建新预设

        Args:
            name: 预设名称
            settings: 抓取的页面设置
            text_content: 提示词内容
            image_uris: 图片 URI 列表
            file_path: 素材文件绝对路径

        Returns:
            创建的预设对象
        """
        import time
        import random
        import string

        # 生成唯一 ID（时间戳 + 随机字符串）
        timestamp = int(time.time() * 1000)
        random_part = ''.join(random.choices(string.ascii_lowercase + string.digits, k=6))
        preset_id = f"{timestamp:x}_{random_part}"

        now = int(time.time() * 1000)

        preset = {
            "id": preset_id,
            "name": name,
            "settings": settings,
            "textContent": text_content,
            "imageURIs": image_uris or [],
            "file_path": file_path,
            "createdAt": now,
            "updatedAt": now
        }

        with self._data_lock:
            self._presets.insert(0, preset)

        self._save()
        logger.info(f"[PresetManager] 创建预设: {name} (ID: {preset_id})")

        return preset.copy()

    def update(self, preset_id: str, updates: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """
        更新预设（部分更新）

        Args:
            preset_id: 预设 ID
            updates: 要更新的字段

        Returns:
            更新后的预设或 None
        """
        import time

        with self._data_lock:
            for i, preset in enumerate(self._presets):
                if preset.get("id") == preset_id:
                    # 合并更新
                    self._presets[i].update(updates)
                    self._presets[i]["updatedAt"] = int(time.time() * 1000)
                    updated = self._presets[i].copy()
                    break
            else:
                return None

        self._save()
        logger.info(f"[PresetManager] 更新预设: {preset_id}")

        return updated

    def delete(self, preset_id: str) -> bool:
        """
        删除指定预设

        Args:
            preset_id: 预设 ID

        Returns:
            是否删除成功
        """
        with self._data_lock:
            original_len = len(self._presets)
            self._presets = [p for p in self._presets if p.get("id") != preset_id]

            if len(self._presets) == original_len:
                return False

        self._save()
        logger.info(f"[PresetManager] 删除预设: {preset_id}")

        return True

    def delete_all(self) -> int:
        """
        清空所有预设

        Returns:
            删除的预设数量
        """
        with self._data_lock:
            count = len(self._presets)
            self._presets = []

        self._save()
        logger.info(f"[PresetManager] 清空所有预设 ({count} 个)")

        return count

    # ==================== 辅助方法 ====================

    def get_file_path(self, preset_id: str) -> Optional[str]:
        """
        获取预设关联的素材文件路径

        Args:
            preset_id: 预设 ID

        Returns:
            文件绝对路径或 None
        """
        preset = self.get_by_id(preset_id)
        if preset:
            return preset.get("file_path")
        return None

    def file_exists(self, preset_id: str) -> bool:
        """
        检查预设关联的素材文件是否存在

        Args:
            preset_id: 预设 ID

        Returns:
            文件是否存在
        """
        file_path = self.get_file_path(preset_id)
        if file_path:
            return os.path.isfile(file_path)
        return False

    def count(self) -> int:
        """获取预设总数"""
        with self._data_lock:
            return len(self._presets)

    def search(self, keyword: str) -> List[Dict[str, Any]]:
        """
        搜索预设（按名称模糊匹配）

        Args:
            keyword: 搜索关键词

        Returns:
            匹配的预设列表
        """
        keyword_lower = keyword.lower()
        with self._data_lock:
            results = [
                p for p in self._presets
                if keyword_lower in p.get("name", "").lower()
            ]
        return sorted(results, key=lambda x: x.get("createdAt", 0), reverse=True)

    def get_summary(self) -> Dict[str, Any]:
        """
        获取数据统计摘要

        Returns:
            包含统计信息字典
        """
        with self._data_lock:
            total = len(self._presets)
            with_files = sum(1 for p in self._presets if p.get("file_path"))
            without_files = total - with_files

            # 按页面类型统计
            page_types = {}
            for p in self._presets:
                pt = p.get("settings", {}).get("pageType", "unknown")
                page_types[pt] = page_types.get(pt, 0) + 1

            # 最新创建时间
            latest = max((p.get("createdAt", 0) for p in self._presets), default=0)

            return {
                "total": total,
                "with_files": with_files,
                "without_files": without_files,
                "page_types": page_types,
                "latest_created": latest
            }


# ============ 全局单例 ============

_preset_manager: Optional[PresetManager] = None


def get_preset_manager() -> PresetManager:
    """获取预设管理器单例"""
    global _preset_manager
    if _preset_manager is None:
        _preset_manager = PresetManager()
    return _preset_manager

# -*- coding: utf-8 -*-
"""
Dreamina Toolkit - Electron IPC 独立入口
=========================================
直接被 Electron main.js 通过子进程 spawn 调用。
无需启动 FastAPI 服务，可独立处理预设操作（文件管理已迁移到 server.py HTTP API）。

用法（命令行参数）：
  python preset_ipc.py <action> [args...]

Actions:
  preset_list                       - 获取所有预设
  preset_get <preset_id>            - 获取单个预设
  preset_create <json_payload>      - 创建预设
  preset_delete <preset_id>         - 删除预设
  preset_search <keyword>           - 搜索预设
  health                            - 健康检查
"""

import json
import sys
import traceback
from pathlib import Path

# 将 SX_DM 目录加入 Python 路径，以便 import preset_manager
_SCRIPT_DIR = Path(__file__).parent.resolve()
sys.path.insert(0, str(_SCRIPT_DIR))

from preset_manager import get_preset_manager


# ============================================================
# Action 路由
# ============================================================

def handle_action(action, args):
    pm = get_preset_manager()

    if action == 'preset_list':
        return {"success": True, "presets": pm.get_all(), "count": pm.count()}

    if action == 'preset_get':
        preset_id = args[0] if args else ''
        preset = pm.get_by_id(preset_id)
        if not preset:
            return {"success": False, "error": f"预设不存在: {preset_id}"}
        return {"success": True, "preset": preset}

    if action == 'preset_create':
        if not args:
            return {"success": False, "error": "缺少预设数据"}
        try:
            payload = json.loads(args[0]) if isinstance(args[0], str) else args[0]
        except json.JSONDecodeError:
            return {"success": False, "error": "无效的 JSON 格式"}
        preset = pm.create(
            name=payload.get('name', '未命名预设'),
            settings=payload.get('settings', {}),
            text_content=payload.get('textContent', payload.get('text_content', '')),
            image_uris=payload.get('imageURIs', payload.get('image_uris', [])),
            file_path=payload.get('file_path', ''),
        )
        return {"success": True, "preset": preset}

    if action == 'preset_delete':
        preset_id = args[0] if args else ''
        success = pm.delete(preset_id)
        return {"success": success, "preset_id": preset_id}

    if action == 'preset_search':
        keyword = args[0] if args else ''
        presets = pm.search(keyword)
        return {"success": True, "presets": presets, "count": len(presets)}

    if action == 'health':
        return {
            "success": True,
            "status": "ok",
            "presets_count": pm.count(),
        }

    return {"success": False, "error": f"未知 action: {action}"}


# ============================================================
# CLI 入口
# ============================================================

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "缺少 action 参数"}))
        sys.exit(1)

    action = sys.argv[1]
    args = sys.argv[2:]

    try:
        result = handle_action(action, args)
    except Exception as e:
        result = {"success": False, "error": str(e), "traceback": traceback.format_exc()}

    # 输出 JSON 到 stdout（main.js 捕获 stdout）
    print(json.dumps(result, ensure_ascii=False))

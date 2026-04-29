# -*- coding: utf-8 -*-
"""
Dreamina Toolkit - Electron IPC 独立入口
=========================================
直接被 Electron main.js 通过子进程 spawn 调用。
无需启动 FastAPI 服务，可独立处理预设和文件操作。

用法（命令行参数）：
  python preset_ipc.py <action> [args...]

Actions:
  preset_list                       - 获取所有预设
  preset_get <preset_id>            - 获取单个预设
  preset_create <json_payload>      - 创建预设
  preset_delete <preset_id>         - 删除预设
  preset_search <keyword>           - 搜索预设

  file_list                         - 获取文件列表
  file_add <json_files>             - 添加文件（校验后追加）
  file_remove <index>               - 删除指定索引的文件
  file_clear                        - 清空文件列表

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
# 文件管理器（复制自 server.py，与 FastAPI 服务共享同一套逻辑）
# ============================================================

MAX_IMAGES = 12
MAX_VIDEOS = 3
MAX_AUDIOS = 3
MAX_TOTAL = 12
MAX_VIDEO_DURATION = 15
MAX_AUDIO_DURATION = 15

_file_list = []


def _validate_and_add_files(incoming_files):
    existing_paths = {f['path'] for f in _file_list}
    new_files = []
    limit_msg = None

    for f in incoming_files:
        path = f.get('path', '')
        file_type = f.get('type', 'unknown')

        if not path or path in existing_paths:
            continue

        if len(_file_list) + len(new_files) >= MAX_TOTAL:
            limit_msg = f"文件总数已达上限 ({MAX_TOTAL} 个)"
            break

        if file_type not in ('image', 'video', 'audio'):
            continue

        counts = {'image': 0, 'video': 0, 'audio': 0}
        for ex in _file_list:
            ct = ex.get('type', 'unknown')
            if ct in counts:
                counts[ct] += 1
        for nf in new_files:
            ct = nf.get('type', 'unknown')
            if ct in counts:
                counts[ct] += 1

        if file_type == 'video' and counts['video'] >= MAX_VIDEOS:
            continue
        elif file_type == 'audio' and counts['audio'] >= MAX_AUDIOS:
            continue

        file_entry = {
            'type': file_type,
            'path': path,
            'name': f.get('name', Path(path).name),
            'url': f.get('url', 'file:///' + path.replace('\\', '/')),
            'thumbnail_base64': f.get('thumbnail_base64', ''),
            'duration': f.get('duration', '00:00'),
            'duration_seconds': float(f.get('duration_seconds', 0)),
        }
        new_files.append(file_entry)

    for f in new_files:
        _file_list.append(f)

    def trim_by_duration(ftype, limit):
        files = [f for f in _file_list if f.get('type') == ftype]
        total = sum(f.get('duration_seconds', 0) for f in files)
        if total <= limit:
            return None
        while files and sum(f.get('duration_seconds', 0) for f in files) > limit:
            removed = files.pop(0)
            _file_list.remove(removed)
        return f"{ftype} 总时长不能超过 {limit} 秒"

    video_msg = trim_by_duration('video', MAX_VIDEO_DURATION)
    audio_msg = trim_by_duration('audio', MAX_AUDIO_DURATION)
    limit_msg = video_msg or audio_msg or limit_msg

    return {
        "success": True,
        "files": list(_file_list),
        "new_count": len(new_files),
        **({"message": limit_msg} if limit_msg else {}),
    }


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

    if action == 'file_list':
        return {"success": True, "files": list(_file_list), "count": len(_file_list)}

    if action == 'file_add':
        if not args:
            return {"success": False, "error": "缺少文件数据"}
        try:
            files = json.loads(args[0]) if isinstance(args[0], str) else args[0]
        except json.JSONDecodeError:
            return {"success": False, "error": "无效的 JSON 格式"}
        if not isinstance(files, list):
            files = [files]
        return _validate_and_add_files(files)

    if action == 'file_remove':
        index = int(args[0]) if args else -1
        if 0 <= index < len(_file_list):
            removed = _file_list.pop(index)
            return {"success": True, "removed": removed, "files": list(_file_list)}
        return {"success": False, "error": f"索引 {index} 超出范围"}

    if action == 'file_clear':
        _file_list.clear()
        return {"success": True, "files": [], "count": 0}

    if action == 'health':
        return {
            "success": True,
            "status": "ok",
            "presets_count": pm.count(),
            "files_count": len(_file_list),
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

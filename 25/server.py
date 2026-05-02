# -*- coding: utf-8 -*-
"""
Dreamina Toolkit - FastAPI + WebSocket 服务端
============================================

【架构说明】
- Electron 桌面端：前端通过 fetch/WebSocket 与 Python FastAPI 通信
- 前端：负责媒体解析（图片/视频/音频缩略图和时长）
- 后端：轻量级校验器，只做业务规则检查和内存状态管理

【职责】
1. HTTP REST API （供 Electron 前端调用）：
   - 文件管理：校验、删除、列表
   - 预设管理： CRUD
2. WebSocket 长连接（供 Chrome 扩展端调用）：
   - GET_PRESETS / CREATE_PRESET / APPLY_PRESET / DELETE_PRESET
"""

import asyncio
import base64
import json
import logging
import mimetypes
import os
import threading
import traceback
from datetime import datetime
from typing import Any, Dict, List, Optional

import uvicorn
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware

from preset_manager import get_preset_manager
from core.jimeng_router import router as jimeng_router

# ============================================================
# 日志配置（basicConfig 只生效一次，由首次 import 的模块触发）
def setup_logging():
    root = logging.getLogger()
    if not root.handlers:
        root.setLevel(logging.INFO)
        ch = logging.StreamHandler()
        ch.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(name)s - %(message)s", datefmt="%H:%M:%S"))
        root.addHandler(ch)
    return logging.getLogger("SX_DM")

log = setup_logging()


# ============================================================
# 【核心】网关软开关
# - True：WebSocket 连接放行，插件可正常对接
# - False：WebSocket 连接立即拒绝（close code 1008）
# 由前端 UI 通过 HTTP 接口切换，不影响 HTTP REST API
# ============================================================
GATEWAY_ENABLED = False


# ============================================================
# 文件管理常量和工具
# ============================================================

MAX_IMAGES = 12
MAX_VIDEOS = 3
MAX_AUDIOS = 3
MAX_TOTAL = 12
MAX_VIDEO_DURATION = 15.1
MAX_AUDIO_DURATION = 15


# ============================================================
# 文件管理器（单例，纯内存，无持久化）
# 服务重启后文件列表自动清空，每次都是全新会话
# 【多租户改造 v2】session 结构升级为组合字典：
#   task_id → {"reference_files": [], "frame_files": {"first": None, "last": None}}
# ============================================================

class FileManager:
    _instance = None
    _lock = threading.Lock()

    def __new__(cls):
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
                    cls._instance._reset()
        return cls._instance

    def _reset(self):
        # 【多租户改造 v2】每个 session: {reference_files: [], frame_files: {first: None, last: None}}
        self._sessions: Dict[str, Dict[str, Any]] = {}
        self._lock = threading.Lock()

    def _ensure_session(self, task_id: str) -> Dict[str, Any]:
        """确保指定 task_id 的 session 存在，不存在则初始化完整结构"""
        if task_id not in self._sessions:
            self._sessions[task_id] = {
                "reference_files": [],
                "frame_files": {"first": None, "last": None}
            }
        return self._sessions[task_id]

    # ===== 参考素材（reference_files）操作 =====

    def get_all(self, task_id: str = "default") -> List[Dict[str, Any]]:
        with self._lock:
            return list(self._ensure_session(task_id).get("reference_files", []))

    def get_by_index(self, task_id: str, index: int) -> Optional[Dict[str, Any]]:
        with self._lock:
            session = self._ensure_session(task_id)
            files = session.get("reference_files", [])
            if 0 <= index < len(files):
                return files[index]
            return None

    def remove(self, task_id: str, index: int) -> Optional[Dict[str, Any]]:
        with self._lock:
            session = self._ensure_session(task_id)
            files = session.setdefault("reference_files", [])
            if 0 <= index < len(files):
                return files.pop(index)
            return None

    def add(self, task_id: str, file_info: Dict[str, Any]):
        with self._lock:
            session = self._ensure_session(task_id)
            session.setdefault("reference_files", []).append(file_info)

    def count(self, task_id: str = "default") -> int:
        with self._lock:
            return len(self._ensure_session(task_id).get("reference_files", []))

    def clear(self, task_id: str = None):
        """清空指定 task_id 或全部 session"""
        with self._lock:
            if task_id:
                self._sessions.pop(task_id, None)
            else:
                self._sessions.clear()

    # ===== 首尾帧（frame_files）操作 =====

    def set_frame(self, task_id: str, frame_type: str, file_info: Dict[str, Any]):
        """
        设置指定 task_id 的首帧或尾帧。
        frame_type: 'first' 或 'last'
        file_info: 包含 path、name、url、thumbnail_base64 等字段的字典
        """
        with self._lock:
            session = self._ensure_session(task_id)
            session.setdefault("frame_files", {"first": None, "last": None})[frame_type] = file_info

    def get_frames(self, task_id: str = "default") -> Dict[str, Any]:
        """返回指定 task_id 的首尾帧字典 {first: {...}|None, last: {...}|None}"""
        with self._lock:
            session = self._ensure_session(task_id)
            return dict(session.get("frame_files", {"first": None, "last": None}))

    def clear_frames(self, task_id: str = None):
        """清空指定 task_id 的首尾帧"""
        with self._lock:
            if task_id and task_id in self._sessions:
                self._sessions[task_id]["frame_files"] = {"first": None, "last": None}
            elif not task_id:
                for sid in self._sessions:
                    self._sessions[sid]["frame_files"] = {"first": None, "last": None}

    # ===== 统计属性 =====

    @property
    def session_count(self) -> int:
        """返回当前活跃 session 数量"""
        with self._lock:
            return len(self._sessions)

    @property
    def reference_count(self, task_id: str = "default") -> int:
        """返回指定 session 的参考素材数量"""
        with self._lock:
            return len(self._ensure_session(task_id).get("reference_files", []))


def get_file_manager() -> FileManager:
    return FileManager()


# ============================================================
# 轻量级文件校验逻辑（同步，纯内存）
# 【多租户改造】所有方法接收 task_id 参数，实现 session 隔离
# ============================================================

def _validate_and_add_files(fm: FileManager, task_id: str, incoming_files: List[dict], for_editor: bool = False) -> dict:
    """
    校验并追加文件：
    1. 去重（按 path）
    2. 总数上限（MAX_TOTAL = 12）
    3. 类型数量限制（MAX_VIDEOS = 3 / MAX_AUDIOS = 3）
    4. 时长限制（视频/音频总时长各 <= 15s），超时从头部移除
    5. for_editor=True 时，给新文件附加 insert_index 供编辑区标签同步
    6. 【多租户】所有操作针对特定 task_id 的 session
    """
    existing_paths = {f['path'] for f in fm.get_all(task_id)}
    new_files: List[Dict[str, Any]] = []
    limit_msg = None
    base_index = len(fm.get_all(task_id))

    for idx, f in enumerate(incoming_files):
        path = f.get('path', '')
        file_type = f.get('type', 'unknown')

        if not path or path in existing_paths:
            log.info(f"[Server] 跳过（空/重复）: {path}")
            continue

        total = len(fm.get_all(task_id)) + len(new_files)
        if total >= MAX_TOTAL:
            limit_msg = f"文件总数已达上限 ({MAX_TOTAL} 个)"
            break

        if file_type not in ('image', 'video', 'audio'):
            log.warning(f"[Server] 未知类型 '{file_type}'，跳过: {path}")
            continue

        # 单文件时长硬上限：超长视频/音频直接拒绝，不影响已有文件
        duration_seconds = float(f.get('duration_seconds', 0))
        # 计算当前已有该类型文件的总时长（不含本批次新文件）
        existing_total = sum(
            ef.get('duration_seconds', 0)
            for ef in fm.get_all(task_id)
            if ef.get('type') == file_type
        )
        if file_type == 'video' and duration_seconds > MAX_VIDEO_DURATION:
            limit_msg = (
                f"视频总时长不能超过 {MAX_VIDEO_DURATION} 秒"
                f"（当前: {int(existing_total)}秒-新素材: {int(duration_seconds)}秒）"
            )
            continue
        elif file_type == 'audio' and duration_seconds > MAX_AUDIO_DURATION:
            limit_msg = (
                f"音频总时长不能超过 {MAX_AUDIO_DURATION} 秒"
                f"（当前: {int(existing_total)}秒-新素材: {int(duration_seconds)}秒）"
            )
            continue

        # 统计当前类型数量
        counts = {'image': 0, 'video': 0, 'audio': 0}
        for ex in fm.get_all(task_id):
            ct = ex.get('type', 'unknown')
            if ct in counts:
                counts[ct] += 1
        for nf in new_files:
            ct = nf.get('type', 'unknown')
            if ct in counts:
                counts[ct] += 1

        if file_type == 'video' and counts['video'] >= MAX_VIDEOS:
            limit_msg = f"视频最多支持 {MAX_VIDEOS} 个"
            continue
        elif file_type == 'audio' and counts['audio'] >= MAX_AUDIOS:
            limit_msg = f"音频最多支持 {MAX_AUDIOS} 个"
            continue

        file_entry: Dict[str, Any] = {
            'type': file_type,
            'path': path,
            'name': f.get('name', os.path.basename(path)),
            'url': f.get('url', 'app-media://local/' + path.replace('\\', '/')),
            'thumbnail_base64': f.get('thumbnail_base64', ''),
            'duration': f.get('duration', '00:00'),
            'duration_seconds': float(f.get('duration_seconds', 0)),
        }

        # 编辑区拖拽时，附加 insert_index 供前端精准定位标签
        if for_editor:
            file_entry['insert_index'] = base_index + len(new_files)

        new_files.append(file_entry)

    # 追加到内存列表
    for f in new_files:
        fm.add(task_id, f)

    # 时长超限：从头部移除直到合规（纯内存操作）
    new_files_total_video = sum(f.get('duration_seconds', 0) for f in new_files if f.get('type') == 'video')
    new_files_total_audio = sum(f.get('duration_seconds', 0) for f in new_files if f.get('type') == 'audio')

    def trim_by_duration(ftype: str, limit: int, new_total: float) -> Optional[str]:
        files = [f for f in fm.get_all(task_id) if f.get('type') == ftype]
        total = sum(f.get('duration_seconds', 0) for f in files)
        if total <= limit:
            return None
        log.info(f"[Server] {ftype} 总时长超限 ({total}s>{limit}s)，自动裁剪")
        while files and sum(f.get('duration_seconds', 0) for f in files) > limit:
            removed = files.pop(0)
            # 直接操作 session 的 reference_files 列表（通过 path 移除）
            session = fm._sessions.get(task_id, {})
            ref_files = session.get("reference_files", [])
            for i, sf in enumerate(ref_files):
                if sf['path'] == removed['path']:
                    ref_files.pop(i)
                    break
        final = sum(f.get('duration_seconds', 0) for f in fm.get_all(task_id) if f.get('type') == ftype)
        type_label = '视频' if ftype == 'video' else '音频'
        return (
            f"{type_label}总时长不能超过 {limit} 秒"
            f"（当前: {int(final)}秒-新素材: {int(new_total)}秒）"
        )

    video_msg = trim_by_duration('video', MAX_VIDEO_DURATION, new_files_total_video)
    audio_msg = trim_by_duration('audio', MAX_AUDIO_DURATION, new_files_total_audio)
    limit_msg = video_msg or audio_msg or limit_msg

    return {
        "success": True,
        "files": fm.get_all(task_id),
        "new_count": len(new_files),
        **({"message": limit_msg} if limit_msg else {}),
    }


# ============================================================
# WebSocket 连接管理器
# ============================================================

class ConnectionManager:
    def __init__(self):
        self.active_connections: Dict[str, WebSocket] = {}
        self.metadata: Dict[str, Dict] = {}
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket, client_id: str, meta: dict = None):
        await websocket.accept()
        async with self._lock:
            self.active_connections[client_id] = websocket
            self.metadata[client_id] = {
                "connected_at": datetime.now().isoformat(),
                "user_agent": websocket.headers.get("user-agent", "unknown"),
                **(meta or {}),
            }
        log.info(f"[WS] 连接: {client_id} (共 {len(self.active_connections)} 个)")

    async def disconnect(self, client_id: str):
        async with self._lock:
            self.active_connections.pop(client_id, None)
            self.metadata.pop(client_id, None)
        log.info(f"[WS] 断开: {client_id} (剩余 {len(self.active_connections)} 个)")

    async def send(self, client_id: str, message: dict):
        async with self._lock:
            ws = self.active_connections.get(client_id)
        if ws:
            await ws.send_json(message)

    async def broadcast(self, message: dict):
        disconnected = []
        async with self._lock:
            connections = list(self.active_connections.items())
        for cid, ws in connections:
            try:
                await ws.send_json(message)
            except Exception:
                disconnected.append(cid)
        for cid in disconnected:
            await self.disconnect(cid)

    @property
    def connection_count(self) -> int:
        return len(self.active_connections)


manager = ConnectionManager()


# ============================================================
# FastAPI 应用
# ============================================================

app = FastAPI(
    title="Dreamina Toolkit - API 服务",
    version="3.0.0",
    description="Electron 前端 + Chrome 扩展端的 HTTP/WebSocket 中转服务",
    docs_url=None,
    redoc_url=None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================
# HTTP API：健康检查
# ============================================================

@app.get("/", tags=["health"])
async def root():
    pm = get_preset_manager()
    fm = get_file_manager()
    return JSONResponse({
        "service": "Dreamina Toolkit",
        "version": "3.0.0",
        "status": "running",
        "gateway_enabled": GATEWAY_ENABLED,
        "connections": manager.connection_count,
        "presets_count": pm.count(),
        "sessions_count": fm.session_count,  # 【多租户】显示活跃 session 数量
        "files_count": sum(fm.count(sid) for sid in fm._sessions),  # 【多租户】所有 session 的文件总数
        "timestamp": datetime.now().isoformat(),
    })


@app.get("/health", tags=["health"])
async def health():
    pm = get_preset_manager()
    fm = get_file_manager()
    return JSONResponse({
        "status": "ok",
        "websocket_connections": manager.connection_count,
        "gateway_enabled": GATEWAY_ENABLED,
        "presets": {"count": pm.count(), "summary": pm.get_summary()},
        "files": {"sessions": fm.session_count, "total_count": sum(fm.count(sid) for sid in fm._sessions)},
    })


# ============================================================
# HTTP API：网关软开关（插件对接控制）
# ============================================================

@app.post("/api/gateway/start", tags=["gateway"])
async def gateway_start():
    """开启网关，允许 WebSocket 连接（插件可对接）"""
    global GATEWAY_ENABLED
    GATEWAY_ENABLED = True
    log.info("[Gateway] 网关已开启")
    # 广播网关状态给所有已连接的客户端（实时推送，无需轮询）
    await manager.broadcast({"type": "GATEWAY_STATUS", "gateway_enabled": True})
    return JSONResponse({"success": True, "gateway_enabled": True})


@app.post("/api/gateway/stop", tags=["gateway"])
async def gateway_stop():
    """关闭网关，断开所有 WebSocket 连接"""
    global GATEWAY_ENABLED
    GATEWAY_ENABLED = False
    log.info("[Gateway] 网关已关闭")
    # 广播网关状态给所有已连接的客户端
    await manager.broadcast({"type": "GATEWAY_STATUS", "gateway_enabled": False})
    return JSONResponse({"success": True, "gateway_enabled": False})


@app.get("/api/gateway/status", tags=["gateway"])
async def gateway_status():
    """查询网关当前状态"""
    return JSONResponse({
        "success": True,
        "gateway_enabled": GATEWAY_ENABLED,
        "websocket_connections": manager.connection_count,
    })


# ============================================================
# HTTP API：文件管理
# 【多租户改造】所有接口接收 task_id 参数，实现 session 隔离
# ============================================================

@app.post("/api/files/process", tags=["files"])
async def process_files(request: dict):
    """
    轻量级文件校验器
    请求体：{ "task_id": "xxx", "files": [{ type, path, name, url, duration, duration_seconds, thumbnail_base64 }, ...], "for_editor": bool }
    响应：{ "success": true, "files": [...], "new_count": n, "message": "..."(可选) }
    """
    incoming_files = request.get("files", [])
    if not incoming_files:
        return JSONResponse({"success": False, "error": "未提供文件列表"})
    # 【多租户】从请求体解析 task_id，默认 "default"
    task_id = request.get("task_id", "default")
    fm = get_file_manager()
    result = _validate_and_add_files(fm, task_id, incoming_files, request.get("for_editor", False))
    return JSONResponse(result)


@app.get("/api/files", tags=["files"])
async def get_files(task_id: str = "default"):
    """获取指定 task_id 的文件列表"""
    fm = get_file_manager()
    return JSONResponse({
        "success": True,
        "files": fm.get_all(task_id),
        "count": fm.count(task_id),
        "task_id": task_id,
    })


@app.delete("/api/files/{index}", tags=["files"])
async def delete_file(index: int, task_id: str = "default"):
    """删除指定 task_id 中指定索引的文件"""
    fm = get_file_manager()
    removed = fm.remove(task_id, index)
    if removed is None:
        raise HTTPException(status_code=404, detail=f"索引 {index} 超出范围 (task_id={task_id})")
    return JSONResponse({
        "success": True,
        "removed": removed,
        "files": fm.get_all(task_id),
        "task_id": task_id,
    })


# ============================================================
# HTTP API：首尾帧管理
# 【多租户改造 v2】首尾帧纳入 task_id 隔离体系
# 首尾帧不参与 MAX_TOTAL / 时长熔断校验，仅覆盖更新对应 frame_type 字段
# ============================================================

@app.post("/api/frames/process", tags=["frames"])
async def process_frame(request: dict):
    """
    同步首尾帧到后端（多租户 task_id 隔离）
    请求体：{ "task_id": "xxx", "frame_type": "first"|"last", "file_path": "...", "name": "...", "thumbnail_base64": "..." }
    响应：{ "success": true, "file_info": {...}, "frames": { "first": {...}|null, "last": {...}|null } }
    """
    task_id = request.get("task_id", "default")
    frame_type = request.get("frame_type", "first")
    file_path = request.get("file_path", "")

    if not file_path:
        return JSONResponse({"success": False, "error": "file_path 不能为空"})
    if frame_type not in ("first", "last"):
        return JSONResponse({"success": False, "error": "frame_type 必须是 'first' 或 'last'"})

    # 构建 file_info（不校验时长和数量限制，直接覆盖）
    file_info = {
        "type": "image",
        "path": file_path,
        "name": request.get("name", os.path.basename(file_path)),
        "url": "app-media://local/" + file_path.replace("\\", "/"),
        "thumbnail_base64": request.get("thumbnail_base64", ""),
        "duration": "00:00",
        "duration_seconds": 0,
    }

    fm = get_file_manager()
    fm.set_frame(task_id, frame_type, file_info)

    return JSONResponse({
        "success": True,
        "file_info": file_info,
        "frames": fm.get_frames(task_id),
    })


@app.get("/api/frames", tags=["frames"])
async def get_frames(task_id: str = "default"):
    """
    获取指定 task_id 的首尾帧（多租户隔离）
    """
    fm = get_file_manager()
    return JSONResponse({
        "success": True,
        "task_id": task_id,
        "frames": fm.get_frames(task_id),
    })


@app.delete("/api/frames", tags=["frames"])
async def clear_frames(task_id: str = "default"):
    """
    清空指定 task_id 的首尾帧（多租户隔离）
    """
    fm = get_file_manager()
    fm.clear_frames(task_id)
    return JSONResponse({
        "success": True,
        "task_id": task_id,
        "frames": {"first": None, "last": None},
    })


# ============================================================
# HTTP API：预设管理
# ============================================================

@app.get("/api/presets", tags=["presets"])
async def get_all_presets():
    pm = get_preset_manager()
    return JSONResponse({
        "success": True,
        "presets": pm.get_all(),
        "count": pm.count(),
    })


@app.post("/api/presets", tags=["presets"])
async def create_preset(request: dict):
    pm = get_preset_manager()
    preset = pm.create(
        name=request.get('name', '未命名预设'),
        settings=request.get('settings', {}),
        text_content=request.get('textContent', request.get('text_content', '')),
        image_uris=request.get('imageURIs', request.get('image_uris', [])),
        file_path=request.get('file_path', ''),
    )
    return JSONResponse({"success": True, "preset": preset})


@app.get("/api/presets/{preset_id}", tags=["presets"])
async def get_preset(preset_id: str):
    pm = get_preset_manager()
    preset = pm.get_by_id(preset_id)
    if not preset:
        raise HTTPException(status_code=404, detail=f"预设不存在: {preset_id}")
    return JSONResponse({"success": True, "preset": preset})


@app.post("/api/presets/{preset_id}/apply", tags=["presets"])
async def apply_preset(preset_id: str):
    pm = get_preset_manager()
    preset = pm.get_by_id(preset_id)
    if not preset:
        raise HTTPException(status_code=404, detail=f"预设不存在: {preset_id}")
    return JSONResponse({"success": True, "preset": preset})


@app.delete("/api/presets/{preset_id}", tags=["presets"])
async def delete_preset(preset_id: str):
    pm = get_preset_manager()
    success = pm.delete(preset_id)
    return JSONResponse({"success": success, "preset_id": preset_id})


@app.post("/api/generate", tags=["tasks"])
async def generate_task(request: dict):
    """HTTP 降级：WebSocket 不可用时通过 HTTP 广播任务"""
    task_id = "http_" + str(datetime.now().timestamp())
    message = {"type": "GENERATE_TASK", "task_id": task_id, **request}
    await manager.broadcast(message)
    return JSONResponse({"success": True, "message": "任务已提交", "task_id": task_id})


# ============================================================
# WebSocket 端点（Chrome 扩展端）
# ============================================================

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    import uuid
    # 【网关软开关】未开启时拒绝连接
    if not GATEWAY_ENABLED:
        await websocket.close(code=1008, reason="Gateway is closed")
        log.info("[WS] 连接被拒绝：网关未开启")
        return

    client_id = str(uuid.uuid4())[:8]
    try:
        await manager.connect(websocket, client_id, {"remote_addr": str(websocket.client)})
        # 连接建立后立即推送当前网关状态，让客户端无需轮询即可感知状态
        await manager.send(client_id, {"type": "GATEWAY_STATUS", "gateway_enabled": GATEWAY_ENABLED})
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_json({"type": "ERROR", "error": "Invalid JSON"})
                continue
            await handle_ws_message(client_id, msg)
    except WebSocketDisconnect:
        log.info(f"[WS] 客户端断开: {client_id}")
    except Exception as e:
        log.error(f"[WS] 异常 [{client_id}]: {e}\n{traceback.format_exc()}")
    finally:
        await manager.disconnect(client_id)


async def handle_ws_message(client_id: str, msg: dict):
    msg_type = msg.get("type", "")
    request_id = msg.get("id", "")
    pm = get_preset_manager()

    if msg_type == "PING":
        await manager.send(client_id, {"type": "PONG", "id": request_id})
        return

    if msg_type == "GET_PRESETS":
        presets = pm.get_all()
        await manager.send(client_id, {
            "type": "PRESETS_LIST",
            "id": request_id,
            "presets": presets,
            "count": len(presets),
        })
        return

    if msg_type == "CREATE_PRESET":
        preset = pm.create(
            name=msg.get("name", "未命名预设"),
            settings=msg.get("settings", {}),
            text_content=msg.get("textContent", ""),
            image_uris=msg.get("imageURIs", []),
            file_path=msg.get("file_path", ""),
        )
        await manager.send(client_id, {
            "type": "PRESET_CREATED",
            "id": request_id,
            "preset": preset,
        })
        log.info(f"[WS] 创建预设: {preset['id']}")
        return

    if msg_type == "APPLY_PRESET":
        preset_id = msg.get("preset_id", "")
        preset = pm.get_by_id(preset_id)
        if not preset:
            await manager.send(client_id, {
                "type": "ERROR",
                "id": request_id,
                "error": f"预设不存在: {preset_id}",
            })
            return
        file_path = preset.get("file_path", "")
        has_file = bool(file_path and os.path.isfile(file_path))
        await manager.send(client_id, {
            "type": "PRESET_DATA",
            "id": request_id,
            "preset": {
                "id": preset["id"],
                "name": preset["name"],
                "settings": preset.get("settings", {}),
                "textContent": preset.get("textContent", ""),
                "imageURIs": preset.get("imageURIs", []),
            },
            "hasFile": has_file,
            "fileName": os.path.basename(file_path) if has_file else None,
            "fileSize": os.path.getsize(file_path) if has_file else None,
            "mime": mimetypes.guess_type(file_path)[0] if has_file else None,
        })
        if has_file:
            try:
                await _stream_file(client_id, request_id, file_path)
            except Exception as e:
                log.error(f"[WS] 文件发送失败: {e}")
                await manager.send(client_id, {
                    "type": "FILE_ERROR",
                    "id": request_id,
                    "error": str(e),
                })
                return
        await manager.send(client_id, {
            "type": "PRESET_COMPLETE",
            "id": request_id,
            "preset_id": preset_id,
        })
        return

    if msg_type == "DELETE_PRESET":
        preset_id = msg.get("preset_id", "")
        success = pm.delete(preset_id)
        await manager.send(client_id, {
            "type": "PRESET_DELETED",
            "id": request_id,
            "preset_id": preset_id,
            "success": success,
        })
        return

    await manager.send(client_id, {
        "type": "ERROR",
        "id": request_id,
        "error": f"Unknown message type: {msg_type}",
    })


async def _stream_file(client_id: str, request_id: str, file_path: str):
    """分块流式发送文件（256KB/块）"""
    chunk_size = 256 * 1024
    file_size = os.path.getsize(file_path)
    offset = 0
    chunk_index = 0
    with open(file_path, "rb") as f:
        while True:
            chunk = f.read(chunk_size)
            if not chunk:
                break
            is_last = (offset + len(chunk)) >= file_size
            data_b64 = base64.b64encode(chunk).decode("ascii")
            await manager.send(client_id, {
                "type": "FILE_CHUNK",
                "id": request_id,
                "chunkIndex": chunk_index,
                "data": data_b64,
                "offset": offset,
                "length": len(chunk),
                "isLast": is_last,
            })
            offset += len(chunk)
            chunk_index += 1
            if chunk_index % 4 == 0:
                await asyncio.sleep(0.005)
    log.info(f"[WS] 文件发送完成: {os.path.basename(file_path)} ({chunk_index} chunks)")


app.include_router(jimeng_router)


# ============================================================
# 启动入口
# ============================================================

def run_server(host: str = "127.0.0.1", port: int = 8765, reload: bool = False):
    log.info(f"{'='*50}")
    log.info(f"  Dreamina Toolkit - API 服务 v3.0")
    log.info(f"  HTTP: http://{host}:{port}")
    log.info(f"  WS:   ws://{host}:{port}/ws")
    log.info(f"{'='*50}")
    uvicorn.run("server:app", host=host, port=port, reload=reload, log_level="info")


if __name__ == "__main__":
    run_server()

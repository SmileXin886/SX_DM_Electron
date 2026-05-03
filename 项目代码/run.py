# -*- coding: utf-8 -*-
"""
Dreamina Toolkit - 启动脚本

启动方式：
    python run.py           → 启动 FastAPI WebSocket 服务（Electron 内部调用）
    python run.py --ui      → 【已废弃】原 PySide6 UI 模式已废除
    npm start              → 启动 Electron + Python 服务（主启动方式）

编码说明：
- 本文件保存为 UTF-8 编码（无 BOM）
- Python stdout/stderr 按 Windows 默认编码（GBK）输出字节流
- Node.js 原封不动透传 Buffer 字节给控制台，控制台自行解析
"""

import argparse
import sys
import os

# 确保使用虚拟环境的包
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
VENV_PYTHON = os.path.join(SCRIPT_DIR, "venv", "Scripts", "python.exe")


def ensure_venv():
    """确保在虚拟环境中运行"""
    if sys.prefix.lower() != SCRIPT_DIR.lower():
        if os.path.exists(VENV_PYTHON):
            print(f"[Info] 切换到虚拟环境...")
            os.execv(VENV_PYTHON, [VENV_PYTHON, __file__] + sys.argv[1:])
        else:
            print("[Warning] 虚拟环境不存在，请先初始化:")
            print(f"  cd {SCRIPT_DIR}")
            print("  python -m venv venv")
            sys.exit(1)


def main():
    parser = argparse.ArgumentParser(description="Dreamina Toolkit - 本地中转服务")
    parser.add_argument("--ui", action="store_true", help="【已废弃】PySide6 UI 模式")
    parser.add_argument("--host", default="127.0.0.1", help="服务地址 (默认 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8765, help="服务端口 (默认 8765)")
    args = parser.parse_args()

    if args.ui:
        print("[Error] PySide6 UI 模式已废除，请使用 Electron 启动：npm start")
        sys.exit(1)

    # 启动 FastAPI + WebSocket 服务
    from server import run_server
    print(f"[Info] 启动 API 服务 -> http://{args.host}:{args.port}")
    print(f"[Info] WS 端点 -> ws://{args.host}:{args.port}/ws")
    print(f"[Info] 文件 API -> http://{args.host}:{args.port}/api/files")
    print(f"[Info] 预设 API -> http://{args.host}:{args.port}/api/presets")
    run_server(host=args.host, port=args.port)


if __name__ == "__main__":
    main()

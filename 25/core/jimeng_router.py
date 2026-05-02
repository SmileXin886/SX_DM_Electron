# -*- coding: utf-8 -*-
"""
即梦账号 API 路由
注册到 server.py 的 FastAPI 应用中
所有 .sxc 导入、账号管理、浏览器启动逻辑收口于此
"""
import asyncio
import threading
from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import JSONResponse

from core.account_manager import get_account_manager
from core.browser_launcher import start_secure_browser

router = APIRouter(prefix="/api/jimeng", tags=["jimeng"])


def _run_browser_in_thread(credentials: dict):
    """在独立线程中运行异步浏览器（避免阻塞 FastAPI 事件循环）"""
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        loop.run_until_complete(start_secure_browser(credentials))
    except Exception as e:
        print(f"[Jimeng] 浏览器线程异常: {e}")
    finally:
        loop.close()


@router.post("/import")
async def import_jimeng_account(file: UploadFile = File(...)):
    """导入 .sxc 加密账号文件"""
    try:
        file_data = await file.read()
        file_name = file.filename or "未命名账号"

        am = get_account_manager()
        account = am.import_account_from_sxc(file_data, file_name)

        return JSONResponse({"success": True, "account": account})
    except ValueError as e:
        return JSONResponse({"success": False, "error": str(e)}, status_code=400)
    except Exception as e:
        print(f"[Jimeng] 导入账号失败: {e}")
        return JSONResponse({"success": False, "error": f"导入失败: {str(e)}"}, status_code=500)


@router.post("/launch")
async def launch_jimeng_account(request: dict):
    """启动账号的安全浏览器窗口"""
    account_id = request.get("account_id")
    if not account_id:
        return JSONResponse({"success": False, "error": "未提供账号ID"})

    try:
        am = get_account_manager()
        credentials = am.get_account_credentials(account_id)

        thread = threading.Thread(
            target=_run_browser_in_thread,
            args=(credentials,),
            daemon=True
        )
        thread.start()

        return JSONResponse({"success": True, "message": "安全窗口已启动"})
    except ValueError:
        return JSONResponse({"success": False, "error": "账号不存在"}, status_code=404)
    except Exception as e:
        print(f"[Jimeng] 启动浏览器失败: {e}")
        return JSONResponse({"success": False, "error": f"启动失败: {str(e)}"})


@router.get("/accounts")
async def list_jimeng_accounts():
    """获取账号列表"""
    am = get_account_manager()
    accounts = am.get_all_accounts()
    return JSONResponse({"success": True, "accounts": accounts, "count": len(accounts)})


@router.delete("/accounts/{account_id}")
async def delete_jimeng_account(account_id: str):
    """删除账号"""
    am = get_account_manager()
    success = am.delete_account(account_id)
    if not success:
        raise HTTPException(status_code=404, detail="账号不存在")
    return JSONResponse({"success": True})

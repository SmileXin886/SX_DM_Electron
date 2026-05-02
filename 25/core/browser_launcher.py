# -*- coding: utf-8 -*-
"""
安全浏览器启动模块
用 Playwright 启动干净的窗口，注入 Cookie、注入指纹、拦截退出
全流程内存操作，用完立即清零凭证
"""
import asyncio
import sys
from typing import Optional


async def _handle_logout_block(route):
    """拦截退出登录请求，清本地 Cookie，不发服务器"""
    try:
        context = route.request.frame.context
        await context.clear_cookies()
    except Exception:
        pass
    await route.abort()


def _build_pw_cookies(cookies: list) -> list:
    """将凭证 Cookie 转换为 Playwright 格式"""
    pw_cookies = []
    for c in cookies:
        pw_c = {
            "name": c["name"],
            "value": c["value"],
            "domain": c["domain"],
            "path": c.get("path", "/"),
            "secure": c.get("secure", True),
            "httpOnly": c.get("httpOnly", False),
            "sameSite": c.get("sameSite", "Lax")
        }
        if c.get("expirationDate"):
            pw_c["expires"] = c["expirationDate"]
        elif c.get("expires"):
            pw_c["expires"] = c["expires"]
        pw_cookies.append(pw_c)
    return pw_cookies


async def _init_script() -> str:
    """抹除自动化特征脚本"""
    return """
Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
Object.defineProperty(navigator, 'plugins', {get: () => [1, 2, 3]});
Object.defineProperty(navigator, 'languages', {get: () => ['zh-CN', 'zh', 'en']});
window.navigator.chrome = { runtime: {} };
Object.defineProperty(window, 'callPhantom', {get: () => undefined});
Object.defineProperty(window, '_phantom', {get: () => undefined});
"""


async def start_secure_browser(credentials: dict) -> bool:
    """
    启动安全浏览器窗口，注入凭证，用完清零
    :param credentials: decrypt_sxc 返回的凭证字典 {cookies, envFingerprint}
    :return: 是否成功启动
    """
    try:
        from playwright.async_api import async_playwright, Error as PlaywrightError
    except ImportError:
        print("[BrowserLauncher] Playwright 未安装，请运行: pip install playwright && playwright install chromium")
        return False

    cookies = credentials.get("cookies", [])
    env = credentials.get("envFingerprint", {})

    user_agent = env.get("userAgent") or (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    )
    locale = env.get("locale") or "zh-CN"
    screen_res = env.get("screenResolution") or "1280x720"

    width, height = map(int, screen_res.split('x'))

    playwright = None
    browser = None
    try:
        playwright = await async_playwright().start()
        browser = await playwright.chromium.launch(
            headless=False,
            args=[
                '--disable-devtools',
                '--no-sandbox',
                '--disable-infobars',
                '--disable-blink-features=AutomationControlled',
                f'--window-size={width},{height}',
                '--disable-extensions',
                '--disable-background-networking',
                '--disable-default-apps',
                '--disable-sync',
                '--disable-translate',
                '--metrics-recording-only',
                '--mute-audio',
                '--no-first-run',
            ]
        )

        context = await browser.new_context(
            user_agent=user_agent,
            locale=locale,
            viewport={"width": width, "height": height},
            ignore_https_errors=True
        )

        pw_cookies = _build_pw_cookies(cookies)
        if pw_cookies:
            await context.add_cookies(pw_cookies)

        await context.route(
            lambda r: 'logout' in r.url.lower() or 'signout' in r.url.lower(),
            _handle_logout_block
        )

        page = await context.new_page()
        await page.add_init_script(await _init_script())

        await page.goto("https://jimeng.jianying.com/", wait_until="networkidle", timeout=30000)

        await page.wait_for_event("close")

    except asyncio.CancelledError:
        pass
    except Exception as e:
        print(f"[BrowserLauncher] 浏览器异常: {e}")
        return False
    finally:
        try:
            if browser:
                await browser.close()
        except Exception:
            pass
        if playwright:
            try:
                await playwright.stop()
            except Exception:
                pass

        cookies.clear()
        env.clear()
        credentials.clear()
        del cookies, env, credentials

    return True


def launch_browser_sync(credentials: dict) -> bool:
    """同步入口，供 FastAPI 端直接调用"""
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(start_secure_browser(credentials))
    finally:
        loop.close()

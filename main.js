/**
 * Dreamina Toolkit - Electron 主进程
 * ================================
 * 职责：
 * 1. 创建 BrowserWindow（暗色标题栏 + Electron 原生窗口）
 * 2. 通过 child_process.spawn 守护 Python server.py 进程
 * 3. 处理 IPC 系统级调用（文件对话框）
 * 4. 应用退出时干净地 kill Python 子进程
 */

const { app, BrowserWindow, ipcMain, dialog, Menu, screen, shell } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

// ==================== 日志工具 ====================
function log(level, ...args) {
    const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const line = `[${ts}] [${level}] ${args.map(a => String(a)).join(' ')}\n`;
    process.stdout.write(line);
}
const logger = {
    info: (...a) => log('INFO', ...a),
    warn: (...a) => log('WARN', ...a),
    error: (...a) => log('ERROR', ...a),
};

// ==================== 全局状态 ====================
let mainWindow = null;
let pythonProcess = null;
const pythonServerUrl = 'http://127.0.0.1:8765';

// 定位脚本目录（开发环境 vs 打包环境）
const isPackaged = app.isPackaged;
const APP_DIR = isPackaged
    ? path.dirname(app.getPath('exe'))
    : path.resolve(__dirname);
const WEB_UI_DIR = path.join(APP_DIR, 'web_ui');
const PYTHON_EXE = isPackaged
    ? path.join(APP_DIR, 'python', 'python.exe')
    : path.join(APP_DIR, 'venv', 'Scripts', 'python.exe');
const SERVER_SCRIPT = path.join(APP_DIR, 'server.py');

function getWindowsVersion() {
    // 通过 os.release() 判断 Windows 版本
    // Windows 10: NT 10.0, build < 22000
    // Windows 11: NT 10.0, build >= 22000
    const release = require('os').release() || '';
    const buildNum = parseInt(release.split('.')[2] || '0', 10);
    return buildNum >= 22000 ? 11 : 10;
}

// ==================== 创建窗口 ====================
function createWindow() {
    // 计算窗口尺寸（屏幕 85%）
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width: sw, height: sh } = primaryDisplay.workAreaSize;
    const winW = Math.floor(sw * 0.85);
    const winH = Math.floor(sh * 0.85);

    // titleBarOverlay 仅 Windows 11 原生支持（且 Chromium build >= 94）
    // Windows 10 使用 titleBarOverlay 会导致渲染进程崩溃，窗口不可见
    // 为保证最大兼容性，始终使用默认标题栏
    const winVer = getWindowsVersion();
    if (winVer >= 11) {
        logger.info('Windows 11 detected, dark title bar available');
    } else {
        logger.info('Windows 10 detected, using standard title bar');
    }

    mainWindow = new BrowserWindow({
        width: winW,
        height: winH,
        minWidth: 900,
        minHeight: 650,
        titleBarStyle: 'default',        // 标准标题栏，兼容所有 Windows 版本
        backgroundColor: '#0f0f0f',
        show: false,                       // 等 ready-to-show 再显示，避免白屏
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,         // 安全隔离 preload 与 renderer
            nodeIntegration: false,         // renderer 不能直接 require('electron')
            webSecurity: false,  // 必须为 false，否则 file:// 协议下的 ES Module 无法加载
            sandbox: false,
        },
    });

    // 加载 web_ui/index.html
    const indexPath = path.join(WEB_UI_DIR, 'index.html');
    mainWindow.loadFile(indexPath).catch(err => {
        logger.error('加载页面失败:', err.message);
    });

    // ready-to-show 后再显示，避免白屏闪烁
    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
        logger.info('窗口已显示');
    });

    // 窗口关闭时清理 Python 进程
    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    logger.info('窗口创建完成');
}

// ==================== 菜单（无）====================
function createMenu() {
    // 禁用默认菜单栏（Windows 隐藏菜单栏，Linux 无 Dock）
    Menu.setApplicationMenu(null);
}

// ==================== Python 进程管理 ====================

/**
 * 启动 Python FastAPI 服务
 */
function startPythonServer() {
    if (pythonProcess) {
        logger.warn('Python 进程已在运行');
        return;
    }

    logger.info('启动 Python 服务:', SERVER_SCRIPT);

    pythonProcess = spawn(PYTHON_EXE, [SERVER_SCRIPT], {
        cwd: APP_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
        windowsHide: true,
        shell: false,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });

    pythonProcess.stdout.on('data', (chunk) => {
        process.stdout.write(chunk);
    });

    pythonProcess.stderr.on('data', (chunk) => {
        process.stderr.write(chunk);
    });

    pythonProcess.on('error', (err) => {
        logger.error('Python 进程启动失败:', err.message);
        pythonProcess = null;
    });

    pythonProcess.on('exit', (code, signal) => {
        logger.info('Python 进程退出: code=' + code + ' signal=' + signal);
        pythonProcess = null;
    });

    logger.info('Python 进程已启动 (PID: ' + pythonProcess.pid + ')');
}

/**
 * 干净地停止 Python 进程
 */
function stopPythonServer() {
    if (!pythonProcess) return;

    logger.info('正在停止 Python 进程...');

    try {
        // Windows 上 SIGTERM 等效：process.kill()
        pythonProcess.kill('SIGTERM');

        // 等待最多 3 秒后强制 kill
        setTimeout(() => {
            if (pythonProcess && !pythonProcess.killed) {
                logger.warn('Python 进程未响应，强制 kill');
                pythonProcess.kill('SIGKILL');
            }
        }, 3000);
    } catch (e) {
        logger.error('停止 Python 进程失败:', e.message);
    }
}

// ==================== IPC 处理器 ====================

/**
 * 【系统级】打开文件选择对话框
 * 前端调用：window.electronAPI.openFileDialog(options)
 * 返回：{ canceled: true } 或 { canceled: false, filePaths: [...] }
 */
ipcMain.handle('dialog:openFile', async (event, options) => {
    options = options || {};
    logger.info('[IPC] dialog:openFile', JSON.stringify(options));

    const defaultOptions = {
        title: '选择文件',
        filters: [
            { name: '媒体文件', extensions: ['png', 'jpg', 'jpeg', 'gif', 'mp4', 'avi', 'mov', 'mkv', 'webm', 'mp3', 'wav', 'aac', 'flac', 'ogg', 'm4a'] },
            { name: '所有文件', extensions: ['*'] },
        ],
        properties: ['openFile', 'multiSelections'],
    };

    const merged = { ...defaultOptions, ...options };
    const result = await dialog.showOpenDialog(mainWindow, merged);

    const resultStr = result.canceled ? '已取消' : (result.filePaths.length + ' 个文件');
    logger.info('[IPC] dialog:openFile 结果:', resultStr);
    return result;
});

/**
 * 【系统级】打开文件夹选择对话框
 * 前端调用：window.electronAPI.openDirectory(options)
 */
ipcMain.handle('dialog:openDirectory', async (event, options) => {
    options = options || {};
    logger.info('[IPC] dialog:openDirectory');

    const result = await dialog.showOpenDialog(mainWindow, {
        title: '选择文件夹',
        properties: ['openDirectory'],
        ...options,
    });

    return result;
});

/**
 * 【系统级】获取 Python 服务地址
 * 前端调用：window.electronAPI.getServerUrl()
 */
ipcMain.handle('app:getServerUrl', async () => {
    return pythonServerUrl;
});

/**
 * 【系统级】获取应用信息
 * 前端调用：window.electronAPI.getAppInfo()
 */
ipcMain.handle('app:getInfo', async () => {
    return {
        version: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
        appPath: APP_DIR,
        webUiPath: WEB_UI_DIR,
        pythonPath: PYTHON_EXE,
    };
});

/**
 * 【系统级】使用系统默认播放器/看图器打开媒体文件
 * 前端调用：window.electronAPI.previewMedia(filePath)
 */
ipcMain.handle('app:previewMedia', async (event, filePath) => {
    logger.info('[IPC] app:previewMedia', filePath);
    await shell.openPath(filePath);
    return true;
});

/**
 * 【系统级】启动 Python 服务
 * 前端调用：window.electronAPI.startServer(host, port)
 */
ipcMain.handle('server:start', async (event, host, port) => {
    startPythonServer();
    return true;
});

/**
 * 【系统级】停止 Python 服务
 * 前端调用：window.electronAPI.stopServer()
 */
ipcMain.handle('server:stop', async (event) => {
    stopPythonServer();
    return true;
});

// ==================== Python IPC 子进程管理 ====================

/**
 * 通过独立 Python 脚本执行 preset CRUD（无需 FastAPI 服务）
 * action: preset_list | preset_get | preset_create | preset_delete | preset_search
 *        file_list | file_add | file_remove | file_clear | health
 */
function runPythonIPC(action, ...args) {
    return new Promise((resolve, reject) => {
        const proc = spawn(PYTHON_EXE, [SERVER_SCRIPT.replace('server.py', 'preset_ipc.py'), action, ...args], {
            cwd: APP_DIR,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            shell: false,
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
        proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

        proc.on('error', (err) => {
            logger.error('Python IPC 进程启动失败:', err.message);
            reject(err);
        });

        proc.on('exit', (code) => {
            if (code !== 0) {
                logger.error('Python IPC 异常退出:', code, stderr);
                reject(new Error('Python IPC exited with code ' + code));
                return;
            }
            try {
                const result = JSON.parse(stdout.trim());
                resolve(result);
            } catch (e) {
                logger.error('Python IPC 输出解析失败:', stdout, e.message);
                reject(new Error('Invalid JSON from Python IPC: ' + stdout));
            }
        });
    });
}

/**
 * 【系统级】预设列表
 */
ipcMain.handle('preset:list', async () => {
    try {
        return await runPythonIPC('preset_list');
    } catch (e) {
        logger.error('[IPC] preset:list 失败:', e.message);
        return { success: false, error: e.message };
    }
});

/**
 * 【系统级】创建预设
 */
ipcMain.handle('preset:create', async (event, presetData) => {
    try {
        return await runPythonIPC('preset_create', JSON.stringify(presetData));
    } catch (e) {
        logger.error('[IPC] preset:create 失败:', e.message);
        return { success: false, error: e.message };
    }
});

/**
 * 【系统级】删除预设
 */
ipcMain.handle('preset:delete', async (event, presetId) => {
    try {
        return await runPythonIPC('preset_delete', presetId);
    } catch (e) {
        logger.error('[IPC] preset:delete 失败:', e.message);
        return { success: false, error: e.message };
    }
});

/**
 * 【系统级】文件列表
 */
ipcMain.handle('file:list', async () => {
    try {
        return await runPythonIPC('file_list');
    } catch (e) {
        logger.error('[IPC] file:list 失败:', e.message);
        return { success: false, error: e.message };
    }
});

/**
 * 【系统级】添加文件
 */
ipcMain.handle('file:add', async (event, files) => {
    try {
        return await runPythonIPC('file_add', JSON.stringify(files));
    } catch (e) {
        logger.error('[IPC] file:add 失败:', e.message);
        return { success: false, error: e.message };
    }
});

/**
 * 【系统级】删除文件
 */
ipcMain.handle('file:remove', async (event, index) => {
    try {
        return await runPythonIPC('file_remove', String(index));
    } catch (e) {
        logger.error('[IPC] file:remove 失败:', e.message);
        return { success: false, error: e.message };
    }
});

/**
 * 【系统级】清空文件
 */
ipcMain.handle('file:clear', async () => {
    try {
        return await runPythonIPC('file_clear');
    } catch (e) {
        logger.error('[IPC] file:clear 失败:', e.message);
        return { success: false, error: e.message };
    }
});

// ==================== 应用生命周期 ====================

app.whenReady().then(() => {
    logger.info('=================================================');
    logger.info('  Dreamina Toolkit 正在启动...');
    logger.info('  Electron: ' + process.versions.electron);
    logger.info('  Node: ' + process.versions.node);
    logger.info('  Chrome: ' + process.versions.chrome);
    logger.info('  打包模式: ' + (isPackaged ? '是' : '开发'));
    logger.info('  APP_DIR: ' + APP_DIR);
    logger.info('  WEB_UI_DIR: ' + WEB_UI_DIR);
    logger.info('  PYTHON_EXE: ' + PYTHON_EXE);
    logger.info('=================================================');

    createMenu();
    createWindow();
    // Python 服务改为由前端按钮控制，不再开机自启

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

// 所有窗口关闭时：应用退出并清理 Python 进程
app.on('window-all-closed', () => {
    // 这里让应用完全退出（包括 Python 进程）
    app.quit();
});

// 应用退出前：确保 Python 进程被清理
app.on('before-quit', () => {
    logger.info('应用即将退出，清理 Python 进程...');
    stopPythonServer();
});

app.on('will-quit', () => {
    logger.info('应用已退出');
});

// 未捕获异常的兜底处理
process.on('uncaughtException', (err) => {
    logger.error('未捕获的异常:', err.message);
    logger.error(err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('未处理的 Promise 拒绝:', reason);
});

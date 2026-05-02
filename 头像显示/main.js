/**
 * Dreamina Toolkit - Electron 主进程
 * ================================
 * 职责：
 * 1. 创建 BrowserWindow（暗色标题栏 + Electron 原生窗口）
 * 2. 常驻守护 Python server.py 进程（auto-start, auto-restart）
 * 3. 处理 IPC 系统级调用（文件对话框）
 * 4. 应用退出时干净地 kill Python 子进程
 */

const { app, BrowserWindow, ipcMain, dialog, Menu, screen, shell, protocol, net, session } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
// ==================== 屏蔽 Chromium 底层噪音 ====================
// 忽略证书相关错误 (解决 net_error -100)
app.commandLine.appendSwitch('ignore-certificate-errors');

// 降低 Chromium 底层的日志输出级别 (解决 Unsupported pixel format 等错误)
// 级别 0 = INFO, 1 = WARNING, 2 = ERROR, 3 = FATAL
app.commandLine.appendSwitch('log-level', '3');
// ================================================================
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
// 注册自定义协议特权（必须在 app.whenReady() 之前执行）
protocol.registerSchemesAsPrivileged([
    {
        scheme: 'app-media',
        privileges: {
            standard: true,
            secure: true,
            supportFetchAPI: true,
            bypassCSP: true,
            corsEnabled: true
        }
    }
]);
let mainWindow = null;
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
    const release = require('os').release() || '';
    const buildNum = parseInt(release.split('.')[2] || '0', 10);
    return buildNum >= 22000 ? 11 : 10;
}

// ==================== 创建窗口 ====================
function createWindow() {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width: sw, height: sh } = primaryDisplay.workAreaSize;
    const winW = Math.floor(sw * 0.85);
    const winH = Math.floor(sh * 0.85);

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
        titleBarStyle: 'default',
        backgroundColor: '#0f0f0f',
        show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            webSecurity: true,
            sandbox: false,
        },
    });

    const indexPath = path.join(WEB_UI_DIR, 'index.html');
    mainWindow.loadFile(indexPath).catch(err => {
        logger.error('加载页面失败:', err.message);
    });

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
        logger.info('窗口已显示');
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    logger.info('窗口创建完成');
}
// ==================== 菜单（无）====================
function createMenu() {
    Menu.setApplicationMenu(null);
}
// ==================== Python 常驻守护 ====================
let pythonProcess = null;
let _restartCount = 0;
const MAX_RESTART = 3;

function spawnPythonServer() {
    if (pythonProcess) {
        pythonProcess.kill('SIGKILL');
        pythonProcess = null;
    }

    logger.info('[Daemon] 启动 Python 服务:', SERVER_SCRIPT);

    pythonProcess = spawn(PYTHON_EXE, [SERVER_SCRIPT], {
        cwd: APP_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
        windowsHide: true,
        shell: false,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });

    pythonProcess.stdout.on('data', (chunk) => { process.stdout.write(chunk); });
    pythonProcess.stderr.on('data', (chunk) => { process.stderr.write(chunk); });

    pythonProcess.on('error', (err) => {
        logger.error('[Daemon] Python 进程启动失败:', err.message);
        pythonProcess = null;
    });

    pythonProcess.on('exit', (code, signal) => {
        logger.info('[Daemon] Python 进程退出: code=' + code + ' signal=' + signal);
        pythonProcess = null;
        if (_restartCount < MAX_RESTART) {
            _restartCount++;
            logger.info('[Daemon] 准备重启 Python 服务 (尝试 ' + _restartCount + '/' + MAX_RESTART + ')...');
            setTimeout(spawnPythonServer, 2000);
        } else {
            logger.error('[Daemon] Python 服务重启次数已达上限，停止自动重启');
        }
    });

    _restartCount = 0;
    logger.info('[Daemon] Python 进程已启动 (PID: ' + pythonProcess.pid + ')');
}

function killPythonServer() {
    if (!pythonProcess) return;
    logger.info('[Daemon] 正在停止 Python 进程...');
    try {
        pythonProcess.kill('SIGTERM');
        setTimeout(() => {
            if (pythonProcess && !pythonProcess.killed) {
                pythonProcess.kill('SIGKILL');
            }
        }, 3000);
    } catch (e) {
        logger.error('[Daemon] 停止 Python 进程失败:', e.message);
    }
}
// ==================== IPC 处理器 ====================
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

ipcMain.handle('app:getServerUrl', async () => {
    return 'http://127.0.0.1:8765';
});

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

ipcMain.handle('app:previewMedia', async (event, filePath) => {
    logger.info('[IPC] app:previewMedia', filePath);
    await shell.openPath(filePath);
    return true;
});

const { getAccountManager, startSecureBrowser } = require('./core');

// 监听刷新列表的事件
ipcMain.on('jimeng:refreshList', () => {
    if (mainWindow) {
        mainWindow.webContents.send('jimeng:refreshList');
    }
});

/**
 * 加载即梦账号列表
 */
ipcMain.handle('jimeng:listAccounts', async () => {
    try {
        const am = getAccountManager();
        return { success: true, accounts: am.getAllAccounts() };
    } catch (e) {
        logger.error('[IPC] jimeng:listAccounts 失败:', e.message);
        return { success: false, error: e.message };
    }
});

/**
 * 导入 .sxc 账号（解密后加密存储）
 */
ipcMain.handle('jimeng:importAccount', async (event, fileBuffer, fileName) => {
    try {
        const am = getAccountManager();
        const buffer = Buffer.from(fileBuffer);
        const account = await am.importAccountFromSxc(buffer, fileName || '未命名账号');
        return { success: true, account };
    } catch (e) {
        logger.error('[IPC] jimeng:importAccount 失败:', e.message);
        return { success: false, error: e.message };
    }
});

/**
 * 启动账号的安全浏览器窗口
 */
ipcMain.handle('jimeng:launchAccount', async (event, accountId) => {
    try {
        const am = getAccountManager();
        const credentials = await am.getAccountCredentials(accountId);

        await startSecureBrowser(credentials, accountId, mainWindow);
        return { success: true };
    } catch (e) {
        logger.error('[IPC] jimeng:launchAccount 失败:', e.message);
        return { success: false, error: e.message };
    }
});

/**
 * 删除即梦账号
 */
ipcMain.handle('jimeng:deleteAccount', async (event, accountId) => {
    try {
        const am = getAccountManager();
        const success = am.deleteAccount(accountId);
        return { success };
    } catch (e) {
        logger.error('[IPC] jimeng:deleteAccount 失败:', e.message);
        return { success: false, error: e.message };
    }
});

/**
 * 通过 preset_ipc.py 执行预设操作
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
            logger.error('[IPC] preset 进程启动失败:', err.message);
            reject(err);
        });

        proc.on('exit', (code) => {
            if (code !== 0) {
                logger.error('[IPC] preset 异常退出:', code, stderr);
                reject(new Error('preset_ipc exited with code ' + code));
                return;
            }
            try {
                resolve(JSON.parse(stdout.trim()));
            } catch (e) {
                logger.error('[IPC] preset 输出解析失败:', stdout, e.message);
                reject(new Error('Invalid JSON from preset_ipc: ' + stdout));
            }
        });
    });
}

ipcMain.handle('preset:list', async () => {
    try { return await runPythonIPC('preset_list'); }
    catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('preset:create', async (event, presetData) => {
    try { return await runPythonIPC('preset_create', JSON.stringify(presetData)); }
    catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('preset:delete', async (event, presetId) => {
    try { return await runPythonIPC('preset_delete', presetId); }
    catch (e) { return { success: false, error: e.message }; }
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

    protocol.registerFileProtocol('app-media', (request, callback) => {
        let filePath = request.url.replace('app-media://local/', '');
        filePath = decodeURIComponent(filePath);
        callback({ path: filePath });
    });

    createMenu();
    createWindow();
    spawnPythonServer();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    app.quit();
});

app.on('before-quit', () => {
    logger.info('应用即将退出，清理 Python 进程...');
    killPythonServer();
});

app.on('will-quit', () => {
    logger.info('应用已退出');
});

process.on('uncaughtException', (err) => {
    logger.error('未捕获的异常:', err.message);
    logger.error(err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('未处理的 Promise 拒绝:', reason);
});

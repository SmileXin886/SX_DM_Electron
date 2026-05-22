/**
 * task_ledger.js - 本地任务账本与持久化模块 (精准清理版)
 */

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

let _ledgerPath = null;

function getLedgerPath() {
    if (!_ledgerPath) {
        try {
            const eApp = app || require('electron').app;
            if (eApp && eApp.isReady()) {
                _ledgerPath = path.join(eApp.getPath('userData'), 'task_ledger.json');
            }
        } catch (e) {}
    }
    return _ledgerPath;
}

function init(appInstance) {
    if (appInstance) {
        _ledgerPath = path.join(appInstance.getPath('userData'), 'task_ledger.json');
    }
}

const _emitter = new EventEmitter();
_emitter.setMaxListeners(100);

const _ledger = new Map();
const _seenHistoryIds = new Set();
const _alienBills = new Map();
let _flushTimer = null;
let _syncLock = false; 
let _isLoaded = false;
let _loadPromise = null;
const FLUSH_DELAY_MS = 300;

const LEDGER_FIELDS = [
    'taskKey', 'submitId', 'userMessageId', 'agentMode', 'taskType',
    'taskTypeName', // 👈 只加这一个，完美保留"视频生成"等名字
    'status', 'timestamp', 'updatedAt', 'localCost', 'real_cost',
    'billed', 'projectId', 'conversationId', 'accountId',
];

function _filterTaskForDisk(task) {
    const filtered = {};
    for (const key of LEDGER_FIELDS) {
        if (task[key] !== undefined) filtered[key] = task[key];
    }
    return filtered;
}

// ==========================================
// 统一写入管道 (逢变必强刷)
// ==========================================
function commitToDisk(forceSync = false) {
    const p = getLedgerPath();
    if (!p) return;

    const filteredTasks = {};
    for (const [key, task] of _ledger) {
        filteredTasks[key] = _filterTaskForDisk(task);
    }
    const data = { version: 1, savedAt: new Date().toISOString(), tasks: filteredTasks };

    if (forceSync) {
        if (_syncLock) return;
        _syncLock = true;
        try {
            fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
        } catch (e) {
            console.error('[TaskLedger] 同步落盘失败:', e);
        } finally {
            _syncLock = false;
        }
        return;
    }

    _scheduleFlush();
}

function _scheduleFlush() {
    if (_flushTimer) clearTimeout(_flushTimer);
    _flushTimer = setTimeout(_flushToDisk, FLUSH_DELAY_MS);
}

async function _flushToDisk() {
    // 🌟 终极防线：写盘前如果发现内存是空的（没读过旧数据），强制先读取！绝不覆盖清空原文件！
    if (!_isLoaded) {
        await load();
    }

    if (_syncLock) return;
    _syncLock = true;
    const p = getLedgerPath();
    if (!p) { _syncLock = false; return; }
    try {
        const dataToSave = {};
        for (const [key, task] of _ledger.entries()) {
            dataToSave[key] = _filterTaskForDisk(task);
        }
        const data = { version: 1, savedAt: new Date().toISOString(), tasks: dataToSave };
        const content = JSON.stringify(data, null, 2);
        const tmpPath = p + '.tmp';
        await fs.promises.writeFile(tmpPath, content, 'utf8');
        await fs.promises.rename(tmpPath, p);
    } catch (err) {}
    _syncLock = false;
}

// ==========================================
// 🌟 核心清理逻辑：直接从内存和磁盘抹除
// ==========================================
function removeTask(taskKey) {
    if (!taskKey) return;
    let changed = false;

    // 🌟 智能识别 ID 类型，优化日志输出格式
    let idType = '未知类型';
    const targetTask = _ledger.get(taskKey);
    if (targetTask) {
        if (targetTask.agentMode || (targetTask.userMessageId === taskKey) || !targetTask.submitId) {
            idType = 'umid 母任务';
        } else if (targetTask.userMessageId && targetTask.userMessageId !== taskKey) {
            idType = 'submit_id 子碎片';
        } else {
            idType = 'submit_id 常规任务';
        }
    }

    // 1. 如果这是一个 Agent 母任务，连同它底下的子碎片一起干掉
    for (const [k, t] of _ledger.entries()) {
        if (t.userMessageId === taskKey && k !== taskKey) {
            _ledger.delete(k);
            changed = true;
            console.log(`[TaskLedger] 🧹 附带清理关联子碎片: [submit_id 子碎片] ${k}`);
        }
    }

    // 2. 删掉本体
    if (_ledger.has(taskKey)) {
        _ledger.delete(taskKey);
        changed = true;
    }

    // 3. 逢删必强刷，让它彻底从 JSON 文件里消失
    if (changed) {
        commitToDisk(true);
        console.log(`[TaskLedger] 🧹 任务已完结，已从账单彻底移除: [${idType}] ${taskKey}`);
    }
}

// ==========================================
// 业务逻辑层
// ==========================================
function createTask(taskKey, payload) {
    if (!taskKey) return null;
    const now = Date.now();

    const existing = _ledger.get(taskKey);
    if (existing) {
        if (payload.agentMode) existing.agentMode = payload.agentMode;
        if (payload.userMessageId) existing.userMessageId = payload.userMessageId;
        if (payload.submitId || payload.submit_id) existing.submitId = payload.submitId || payload.submit_id;
        if (payload.accountId) existing.accountId = payload.accountId;
        
        Object.assign(existing, payload, { updatedAt: now });

        commitToDisk(true);
        _emitter.emit('ledger:taskUpdated', { taskKey, task: existing });
        return taskKey;
    }

    const isAgent = Boolean(payload.agentMode);
    const resolvedSubmitId = payload.submitId || payload.submit_id || (!isAgent ? taskKey : null);
    const resolvedUserMessageId = payload.userMessageId || (isAgent ? taskKey : null);

    const task = {
        taskKey,
        userMessageId: resolvedUserMessageId,
        submitId: resolvedSubmitId,
        agentMode: payload.agentMode || '',
        prompt: payload.prompt || '',
        taskType: payload.taskType || 'image',
        taskTypeName: payload.taskTypeName || '生成任务',
        billingId: payload.billingId || 'auto_catch',
        resolution: payload.resolution || '-',
        duration: payload.duration || 0,
        localCost: payload.localCost || 5,
        real_cost: payload.real_cost || 0,
        projectId: payload.projectId || null,
        conversationId: payload.conversationId || null,
        status: payload.status || 'pending',
        isAlien: payload.isAlien || false,
        billed: payload.billed || false,
        timestamp: payload.timestamp || now,
        updatedAt: now,
        accountId: payload.accountId || null,
    };

    _ledger.set(taskKey, task);
    commitToDisk(true);
    _emitter.emit('ledger:taskCreated', { taskKey, task });
    return taskKey;
}

function bindSubmitIdToUserMessageId(submitId, userMessageId) {
    if (!submitId || !userMessageId) return;

    let submitTask = _ledger.get(submitId);
    let umTask = _ledger.get(userMessageId);

    let taskToKeep = submitTask || umTask;
    if (!taskToKeep) return;

    taskToKeep.userMessageId = userMessageId;
    taskToKeep.submitId = submitId;
    taskToKeep.status = 'confirmed';

    if (umTask && umTask !== taskToKeep) {
        taskToKeep.agentMode = taskToKeep.agentMode || umTask.agentMode;
        taskToKeep.prompt = taskToKeep.prompt || umTask.prompt;
        taskToKeep.projectId = taskToKeep.projectId || umTask.projectId;
        taskToKeep.conversationId = taskToKeep.conversationId || umTask.conversationId;
    }

    _ledger.set(submitId, taskToKeep);
    _ledger.set(userMessageId, taskToKeep);

    taskToKeep.isAlien = false;
    taskToKeep.updatedAt = Date.now();
    
    commitToDisk(true);
    _emitter.emit('ledger:taskUpdated', { taskKey: submitId, task: taskToKeep });
}

function updateTaskBySubmitId(submitId, updates) {
    if (!submitId) return;
    const task = _ledger.get(submitId);
    if (task) {
        Object.assign(task, updates, { updatedAt: Date.now() });
        commitToDisk(true);
        _emitter.emit('ledger:taskUpdated', { taskKey: submitId, task });
    }
}

function getTask(key) { return _ledger.get(key) || null; }

function getTaskByProjectId(projectId) {
    if (!projectId) return null;
    for (const task of _ledger.values()) {
        if (task.projectId && String(task.projectId) === String(projectId)) return task;
    }
    return null;
}

function markAsBilled(submitId, realCost) {
    const task = _ledger.get(submitId);
    if (task) {
        task.billed = true;
        task.status = 'billed';
        task.real_cost = realCost;
        task.updatedAt = Date.now();
        commitToDisk(true);
        _emitter.emit('ledger:taskUpdated', { taskKey: submitId, task });
    }
}

function markAsRefunded(submitId, refundAmount) {
    const task = _ledger.get(submitId);
    if (task) {
        task.status = 'refunded';
        task.updatedAt = Date.now();
        commitToDisk(true);
        _emitter.emit('ledger:taskUpdated', { taskKey: submitId, task });
        
        // 🌟 收到官方退款，说明任务彻底凉了，直接从账本移除！
        removeTask(submitId);
    }
}

function markAsSettled(submitId, realCost) {
    const task = _ledger.get(submitId);
    if (task) {
        task.status = 'settled';
        task.billed = true;
        task.real_cost = realCost;
        task.updatedAt = Date.now();
        commitToDisk(true);
        _emitter.emit('ledger:taskSettled', { taskKey: submitId, task });
    }
}

function markHistoryIdSeen(historyId) { _seenHistoryIds.add(historyId); }
function isHistoryIdSeen(historyId) { return _seenHistoryIds.has(historyId); }
function getUnboundPendingTasks() { return Array.from(_ledger.values()).filter(t => t.status === 'pending' && !t.submitId); }
function getAllPendingTasks() { return Array.from(_ledger.values()).filter(t => t.status === 'pending' || t.status === 'confirmed'); }
function getAgentPendingTasks() { return Array.from(_ledger.values()).filter(t => (t.status === 'pending' || t.status === 'confirmed') && t.agentMode); }
function getAllTasks() { return Array.from(_ledger.values()); }
function on(event, listener) { _emitter.on('ledger:' + event, listener); }
function off(event, listener) { _emitter.off('ledger:' + event, listener); }

async function load() {
    if (_isLoaded) return;
    if (!_loadPromise) {
        _loadPromise = (async () => {
            const p = getLedgerPath();
            if (!p) { _isLoaded = true; return; }
            try {
                const content = await fs.promises.readFile(p, 'utf8');
                const data = JSON.parse(content);
                if (data.tasks) {
                    for (const [key, task] of Object.entries(data.tasks)) {
                        // 🌟 核心：增量合并，旧数据绝不覆盖内存里的新数据
                        if (!_ledger.has(key)) _ledger.set(key, task);
                    }
                }
                console.log('[TaskLedger] 账本已挂载，当前总任务:', _ledger.size);
            } catch (err) {}
            _isLoaded = true;
        })();
    }
    return _loadPromise;
}

async function flushSync() {
    if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
    commitToDisk(true);
}

async function clear() {
    _ledger.clear();
    _seenHistoryIds.clear();
    const p = getLedgerPath();
    try { if (p) await fs.promises.unlink(p); } catch (err) {}
}

function addAlienBill(submitId, amount) { if (submitId) _alienBills.set(submitId, Math.abs(amount)); }
function getAlienBills() { return Array.from(_alienBills.keys()); }
function getAlienBillCost(submitId) { return _alienBills.get(submitId) || 0; }
function removeAlienBill(submitId) { if (submitId) _alienBills.delete(submitId); }

// 🌟 只要模块被引入，自动跟随 Electron 生命周期初始化并加载，防止外部遗漏调用
if (app) {
    if (app.isReady()) {
        init(app);
        load();
    } else {
        app.whenReady().then(() => {
            init(app);
            load();
        });
    }
}

module.exports = {
    init, createTask, bindSubmitIdToUserMessageId, updateTaskBySubmitId, getTask,
    getTaskByProjectId,
    markAsBilled, markAsRefunded, markAsSettled, markHistoryIdSeen, isHistoryIdSeen,
    getUnboundPendingTasks, getAllPendingTasks, getAgentPendingTasks, getAllTasks,
    addAlienBill, getAlienBills, getAlienBillCost, removeAlienBill,
    on, off, load, flushSync, clear, removeTask, // 👈 导出了移除方法
};
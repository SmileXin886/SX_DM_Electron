/**
 * task_ledger.js - 本地任务账本与持久化模块
 *
 * 【架构维护记录】
 * TODO: 目前画布Agent模式已暂停使用，该组件暂不更新。
 * 现有关联功能已保留以防破坏其他模块，画布Agent请求已由 canvas_agent_blocker.js 在前端层面屏蔽。
 * 请勿修改或破坏此处的历史逻辑。
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
const _alienBills = new Map(); // 未决账单池：submitId -> amount（被动收集用于追溯核账）
let _flushTimer = null;
const FLUSH_DELAY_MS = 300;

function createTask(taskKey, payload) {
    if (!taskKey) return null;
    const now = Date.now();

    const existing = _ledger.get(taskKey);
    if (existing) {
        Object.assign(existing, payload, { updatedAt: now });
        // 🌟 修复：如果有真实的 userMessageId，一定要更新它
        if (payload.userMessageId) existing.userMessageId = payload.userMessageId;
        _scheduleFlush();
        _emitter.emit('ledger:taskUpdated', { taskKey, task: existing });
        return taskKey;
    }

    const task = {
        taskKey,
        // 🌟 修复：优先使用 payload 里的 userMessageId，如果没有才用 taskKey 兜底
        userMessageId: payload.userMessageId || taskKey,
        submitId: payload.submitId || null,
        agentMode: payload.agentMode || '',
        prompt: payload.prompt || '',
        taskType: payload.taskType || 'image',
        taskTypeName: payload.taskTypeName || '生成任务',
        billingId: payload.billingId || 'auto_catch',
        resolution: payload.resolution || '-',
        duration: payload.duration || 0,
        localCost: payload.localCost || 5,
        real_cost: 0,
        // 🌟 画布家谱钥匙：画布模式必须持此钥匙才能查家谱
        projectId: payload.projectId || null,
        // 🌟 会话上下文：可能包含 conversationId 等信息
        conversationId: payload.conversationId || null,
        status: 'pending',
        isAlien: false,
        billed: false,
        timestamp: now,
        updatedAt: now,
    };

    _ledger.set(taskKey, task);

    // 🌟 核心修改：立即强制写入磁盘，防止逃单/烂账
    try {
        const p = getLedgerPath();
        if (p) {
            const data = { version: 1, savedAt: new Date().toISOString(), tasks: Object.fromEntries(_ledger) };
            fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
        }
    } catch (e) {
        console.error('[TaskLedger] 强制落盘失败:', e);
    }

    _scheduleFlush(); // 保留原有的延迟异步刷新作为备份
    _emitter.emit('ledger:taskCreated', { taskKey, task }); // 确保触发事件
    return taskKey;
}

function bindSubmitIdToUserMessageId(submitId, userMessageId) {
    if (!submitId || !userMessageId) return;

    // 尝试拿两个坑位的任务
    let submitTask = _ledger.get(submitId);
    let umTask = _ledger.get(userMessageId);

    let taskToKeep = submitTask || umTask;
    if (!taskToKeep) return;

    taskToKeep.userMessageId = userMessageId;
    taskToKeep.submitId = submitId;
    taskToKeep.status = 'confirmed';

    // 🌟 修复：如果原来那个幽灵任务存在，把它的关键信息吸收到新任务里
    if (umTask && umTask !== taskToKeep) {
        taskToKeep.agentMode = taskToKeep.agentMode || umTask.agentMode;
        taskToKeep.prompt = taskToKeep.prompt || umTask.prompt;
        // 🌟 画布家谱钥匙保护：projectId 和 conversationId 同样需要吸收
        taskToKeep.projectId = taskToKeep.projectId || umTask.projectId;
        taskToKeep.conversationId = taskToKeep.conversationId || umTask.conversationId;
    }

    // 强制双向映射，让幽灵键位指向同一个真实对象
    _ledger.set(submitId, taskToKeep);
    _ledger.set(userMessageId, taskToKeep);

    taskToKeep.isAlien = false;
    taskToKeep.updatedAt = Date.now();
    _scheduleFlush();
    _emitter.emit('ledger:taskUpdated', { taskKey: submitId, task: taskToKeep });
}

function updateTaskBySubmitId(submitId, updates) {
    if (!submitId) return;
    const task = _ledger.get(submitId);
    if (task) {
        Object.assign(task, updates, { updatedAt: Date.now() });
        _scheduleFlush();
        _emitter.emit('ledger:taskUpdated', { taskKey: submitId, task });
    }
}

function getTask(key) { return _ledger.get(key) || null; }

/**
 * 按 projectId 查找 Agent 任务（用于画布模式家谱追溯）
 */
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
        _scheduleFlush();
        _emitter.emit('ledger:taskUpdated', { taskKey: submitId, task });
    }
}

function markAsRefunded(submitId, refundAmount) {
    const task = _ledger.get(submitId);
    if (task) {
        task.status = 'refunded';
        task.updatedAt = Date.now();
        _scheduleFlush();
        _emitter.emit('ledger:taskUpdated', { taskKey: submitId, task });
    }
}

function markAsSettled(submitId, realCost) {
    const task = _ledger.get(submitId);
    if (task) {
        task.status = 'settled';
        task.billed = true;
        task.real_cost = realCost;
        task.updatedAt = Date.now();
        _scheduleFlush();
        _emitter.emit('ledger:taskSettled', { taskKey: submitId, task });
    }
}

function markHistoryIdSeen(historyId) { _seenHistoryIds.add(historyId); }
function isHistoryIdSeen(historyId) { return _seenHistoryIds.has(historyId); }

function getUnboundPendingTasks() {
    return Array.from(_ledger.values()).filter(t => t.status === 'pending' && !t.submitId);
}

function getAllPendingTasks() {
    return Array.from(_ledger.values()).filter(t => t.status === 'pending' || t.status === 'confirmed');
}

function getAgentPendingTasks() {
    return Array.from(_ledger.values()).filter(t =>
        (t.status === 'pending' || t.status === 'confirmed') && t.agentMode
    );
}

function getAllTasks() { return Array.from(_ledger.values()); }

function on(event, listener) { _emitter.on('ledger:' + event, listener); }
function off(event, listener) { _emitter.off('ledger:' + event, listener); }

function _scheduleFlush() {
    if (_flushTimer) clearTimeout(_flushTimer);
    _flushTimer = setTimeout(_flushToDisk, FLUSH_DELAY_MS);
}

async function _flushToDisk() {
    const p = getLedgerPath();
    if (!p) return;
    try {
        const data = { version: 1, savedAt: new Date().toISOString(), tasks: Object.fromEntries(_ledger) };
        const content = JSON.stringify(data, null, 2);
        const tmpPath = p + '.tmp';
        await fs.promises.writeFile(tmpPath, content, 'utf8');
        await fs.promises.rename(tmpPath, p);
    } catch (err) {}
}

async function load() {
    const p = getLedgerPath();
    if (!p) return;
    try {
        const content = await fs.promises.readFile(p, 'utf8');
        const data = JSON.parse(content);
        if (data.tasks) {
            for (const [key, task] of Object.entries(data.tasks)) _ledger.set(key, task);
        }
        console.log('[TaskLedger] 账本已加载，共', _ledger.size, '条记录');
    } catch (err) {}
}

async function flushSync() {
    if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
    await _flushToDisk();
}

async function clear() {
    _ledger.clear();
    _seenHistoryIds.clear();
    const p = getLedgerPath();
    try { if (p) await fs.promises.unlink(p); } catch (err) {}
}

function addAlienBill(submitId, amount) {
    if (!submitId) return;
    _alienBills.set(submitId, Math.abs(amount));
}

function getAlienBills() {
    return Array.from(_alienBills.keys());
}

function getAlienBillCost(submitId) {
    return _alienBills.get(submitId) || 0;
}

function removeAlienBill(submitId) {
    if (submitId) _alienBills.delete(submitId);
}

module.exports = {
    init, createTask, bindSubmitIdToUserMessageId, updateTaskBySubmitId, getTask,
    getTaskByProjectId,
    markAsBilled, markAsRefunded, markAsSettled, markHistoryIdSeen, isHistoryIdSeen,
    getUnboundPendingTasks, getAllPendingTasks, getAgentPendingTasks, getAllTasks,
    addAlienBill, getAlienBills, getAlienBillCost, removeAlienBill,
    on, off, load, flushSync, clear,
};
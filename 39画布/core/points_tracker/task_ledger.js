/**
 * task_ledger.js - 本地任务账本与持久化模块
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
let _flushTimer = null;
const FLUSH_DELAY_MS = 300;

// 孤儿账单暂存池：解决账单先到、探针后到的异步时序问题
const orphanBills = new Map(); // submitId -> { record, timer, settled }
const ORPHAN_BILL_TIMEOUT_MS = 8000; // 8 秒保底超时

function addOrphanBill(submitId, record) {
    // 🌟 修复：如果账单已经在等了，绝不重置它的时间！让它安心走完 8 秒！
    if (orphanBills.has(submitId)) return;

    const timer = setTimeout(() => {
        orphanBills.delete(submitId);
        _emitter.emit('orphan:timeout', { submitId, record });
    }, ORPHAN_BILL_TIMEOUT_MS);
    orphanBills.set(submitId, { record, timer, settled: false });
}

function checkAndSettleOrphanBill(submitId) {
    const entry = orphanBills.get(submitId);
    if (!entry || entry.settled) return;
    entry.settled = true;
    if (entry.timer) clearTimeout(entry.timer);
    orphanBills.delete(submitId);
    _emitter.emit('orphan:settled', { submitId, record: entry.record });
}

function hasOrphanBill(submitId) { return orphanBills.has(submitId); }

function forceSettleAlienOrphan(submitId, taskInfo) {
    const entry = orphanBills.get(submitId);
    if (!entry || entry.settled) return;

    entry.settled = true;
    if (entry.timer) clearTimeout(entry.timer);
    orphanBills.delete(submitId);

    const record = entry.record;
    const historyId = record.history_id || `${record.submit_id}_${record.create_time}`;
    markHistoryIdSeen(historyId);

    _emitter.emit('orphan:alien_force_release', { submitId, record, taskInfo });
}

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

function markHistoryIdSeen(historyId) { _seenHistoryIds.add(historyId); }
function isHistoryIdSeen(historyId) { return _seenHistoryIds.has(historyId); }

function getUnboundPendingTasks() {
    return Array.from(_ledger.values()).filter(t => t.status === 'pending' && !t.submitId);
}

function getAllPendingTasks() {
    return Array.from(_ledger.values()).filter(t => t.status === 'pending' || t.status === 'confirmed');
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

module.exports = {
    init, createTask, bindSubmitIdToUserMessageId, updateTaskBySubmitId, getTask,
    markAsBilled, markAsRefunded, markHistoryIdSeen, isHistoryIdSeen,
    getUnboundPendingTasks, getAllPendingTasks, getAllTasks,
    addOrphanBill, checkAndSettleOrphanBill, hasOrphanBill, forceSettleAlienOrphan,
    on, off, load, flushSync, clear,
};
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

const _billWaitingRoom = new Map();
const BILL_WAIT_TIMEOUT_MS = 120000; 

function createTask(userMessageId, payload) {
    if (!userMessageId) return null;
    const taskKey = userMessageId;
    const now = Date.now();

    const existing = _ledger.get(taskKey);
    if (existing) {
        Object.assign(existing, payload, { updatedAt: now });
        _scheduleFlush();
        _emitter.emit('ledger:taskUpdated', { taskKey, task: existing });
        return taskKey;
    }

    const task = {
        taskKey,
        userMessageId,
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
    _scheduleFlush();
    _emitter.emit('ledger:taskCreated', { taskKey, task });
    return taskKey;
}

function bindSubmitIdToUserMessageId(submitId, userMessageId) {
    if (!submitId || !userMessageId) return;
    let task = _ledger.get(submitId) || _ledger.get(userMessageId);

    // 🚫 核心防御：绝不在绑定阶段凭空捏造任务！
    // 如果账本里没有，说明这是别人历史记录里的数据，直接无视！
    if (!task) return; 
    
    // 我们自己的任务，更新绑定关系
    if (task.userMessageId !== userMessageId) task.userMessageId = userMessageId;
    if (!task.submitId) {
        task.submitId = submitId;
        _ledger.set(submitId, task);
    }
    task.status = 'confirmed';
    task.isAlien = false; 
    task.updatedAt = Date.now();
    _scheduleFlush();
    _emitter.emit('ledger:taskUpdated', { taskKey: submitId, task });

    // 释放等待室
    if (_billWaitingRoom.has(submitId)) {
        const suspended = _billWaitingRoom.get(submitId);
        _billWaitingRoom.delete(submitId);
        const historyId = suspended.record.history_id || `${submitId}_${suspended.record.create_time}`;
        markHistoryIdSeen(historyId);
        _emitter.emit('ledger:billReleased', { submitId, record: suspended.record });
    }
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

function addToWaitingRoom(submitId, record, onTimeout) {
    if (_billWaitingRoom.has(submitId)) return; 
    const addedAt = Date.now();
    _billWaitingRoom.set(submitId, { record, addedAt });

    const timer = setTimeout(() => {
        if (_billWaitingRoom.has(submitId)) {
            _billWaitingRoom.delete(submitId);
            if (typeof onTimeout === 'function') onTimeout(submitId, record);
        }
    }, BILL_WAIT_TIMEOUT_MS);
    _billWaitingRoom.get(submitId).timer = timer;
}

function isInWaitingRoom(submitId) { return _billWaitingRoom.has(submitId); }
function removeFromWaitingRoom(submitId) {
    if (_billWaitingRoom.has(submitId)) {
        const entry = _billWaitingRoom.get(submitId);
        if (entry.timer) clearTimeout(entry.timer);
        _billWaitingRoom.delete(submitId);
    }
}

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
    _billWaitingRoom.forEach(entry => { if (entry.timer) clearTimeout(entry.timer); });
    _billWaitingRoom.clear();
    const p = getLedgerPath();
    try { if (p) await fs.promises.unlink(p); } catch (err) {}
}

module.exports = {
    init, createTask, bindSubmitIdToUserMessageId, updateTaskBySubmitId, getTask, markAsBilled, markAsRefunded, markHistoryIdSeen, isHistoryIdSeen, getUnboundPendingTasks, getAllPendingTasks, getAllTasks, addToWaitingRoom, isInWaitingRoom, removeFromWaitingRoom, on, off, load, flushSync, clear,
};
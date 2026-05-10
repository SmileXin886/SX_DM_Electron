/**
 * history_sync.js - 历史追溯与对账模块（延迟追溯 + 严格 Alien 隔离版）
 *
 * 核心原则：
 * - 放弃孤儿池缓冲机制，账单来即判定。
 * - 本地账本有任务 → 正常结算；无任务 → 立即 Alien，不等待。
 * - Agent 任务的所有扣费碎片在实时阶段全部归入 Alien，
 *   由 agent_reconciler.js 每 2 分钟统一追溯归总。
 */
const TaskLedger = require('./task_ledger');

const logger = {
    info: (...a) => console.log('[PointsTracker]', new Date().toLocaleTimeString('zh-CN', { hour12: false }), ...a),
    warn: (...a) => console.warn('[PointsTracker]', ...a),
    error: (...a) => console.error('[PointsTracker]', ...a),
};

let _onPointsUpdate = null;
let _isFirstCreditLoad = true;
const _sessionStartTimeSec = Date.now() / 1000;

function init(onPointsUpdate) {
    _onPointsUpdate = onPointsUpdate;

    // 监听本地账本创建事件：Agent 任务瞬间通知 UI 显示"核算中"
    TaskLedger.on('taskCreated', ({ taskKey, task }) => {
        if (task.agentMode || (task.taskTypeName && task.taskTypeName.includes('Agent'))) {
            emitToUI({
                type: 'pending_display',
                userMessageId: task.userMessageId,
                agentMode: task.agentMode,
                taskTypeName: task.agentMode || task.taskTypeName,
                prompt: task.prompt,
                timestamp: task.timestamp,
                status: 'pending'
            });
        }
    });
}

function emitToUI(payload) {
    if (typeof _onPointsUpdate === 'function') _onPointsUpdate(payload);
}

function extractUserMessageId(task) {
    if (task.metrics_extra) {
        try {
            const extra = typeof task.metrics_extra === 'string' ? JSON.parse(task.metrics_extra) : task.metrics_extra;
            if (extra.userMessageId) return extra.userMessageId;
        } catch (e) {}
    }
    return null;
}

function classifyTaskType(task, ledgerTask) {
    const draftContentStr = task.draft_content || '';
    const modelKey = String(task.model_info?.model_req_key || '').toLowerCase();
    const mode = task.mode || '';
    const generateType = task.generate_type;

    let taskType = 'image';
    let taskTypeName = '图片生成';

    if (generateType === 2 || modelKey.includes('video') || modelKey.includes('seedance') || draftContentStr.includes('gen_video')) {
        taskType = 'video'; taskTypeName = '视频生成';
    } else if (generateType === 3 || modelKey.includes('audio') || modelKey.includes('tts')) {
        taskType = 'audio'; taskTypeName = '音频配音';
    }

    const isAgent = mode.includes('creation_agent') || draftContentStr.includes('creation_agent');

    if (ledgerTask && ledgerTask.agentMode) {
        taskTypeName = ledgerTask.agentMode;
    } else if (isAgent) {
        taskTypeName = mode.includes('infinite') ? '画布 Agent' : '标准 Agent';
    }

    return { taskType, taskTypeName };
}

function extractPrompt(task) {
    const draftContentStr = task.draft_content || '';
    let prompt = task.history_group_key || '智能体生成任务';
    if (draftContentStr) {
        try {
            const comp = JSON.parse(draftContentStr).component_list?.[0];
            prompt = comp?.abilities?.generate?.core_param?.prompt || comp?.abilities?.gen_video?.text_to_video_params?.video_gen_inputs?.[0]?.prompt || prompt;
        } catch (e) {}
    }
    return String(prompt).slice(0, 30);
}

function processHistoryTasks(tasks) {
    for (const rawTask of tasks) {
        const submitId = rawTask.submit_id || rawTask.capflow_id;
        if (!submitId) continue;

        const ledgerTask = TaskLedger.getTask(submitId);
        if (!ledgerTask) continue;

        const umId = extractUserMessageId(rawTask);
        const { taskType, taskTypeName } = classifyTaskType(rawTask, ledgerTask);
        const prompt = extractPrompt(rawTask);

        if (umId) {
            TaskLedger.bindSubmitIdToUserMessageId(submitId, umId);
        }
        TaskLedger.updateTaskBySubmitId(submitId, { taskType, taskTypeName, prompt, resolution: rawTask.resolution || '-' });
    }
}

function processCreditRecords(records) {
    if (_isFirstCreditLoad) {
        for (const r of records) {
            TaskLedger.markHistoryIdSeen(r.history_id || `${r.submit_id}_${r.create_time}`);
        }
        _isFirstCreditLoad = false;
        return;
    }

    const sortedRecords = [...records].reverse();
    for (const record of sortedRecords) {
        const recordTime = record.create_time || 0;
        if (recordTime > 0 && recordTime < _sessionStartTimeSec) {
            TaskLedger.markHistoryIdSeen(record.history_id || `${record.submit_id}_${record.create_time}`);
            continue;
        }
        _settleSingleRecord(record);
    }
}

function _settleSingleRecord(record) {
    const historyId = record.history_id || `${record.submit_id}_${record.create_time}`;
    const submitId = record.submit_id;
    if (!submitId) return;

    if (TaskLedger.isHistoryIdSeen(historyId)) return;

    const amount = record.amount || 0;
    const ledgerTask = TaskLedger.getTask(submitId);

    const recordTitle = record.title || '';
    const isRecordAgent = recordTitle.includes('Agent') || recordTitle.includes('画布') || recordTitle.includes('智能体');
    const alienTaskType = recordTitle.includes('视频') ? 'video' : (recordTitle.includes('音频') ? 'audio' : 'image');
    const alienTaskTypeName = recordTitle || '生成任务';

    // === 退款 (Refund) ===
    if (record.history_type === 1) {
        if (!ledgerTask) {
            TaskLedger.markHistoryIdSeen(historyId);
            emitToUI({
                type: 'refund', refund: amount, billingId: '即时任务',
                taskType: alienTaskType,
                taskTypeName: alienTaskTypeName,
                prompt: record.history_group_key || '他人操作',
                isAlien: true, submit_id: submitId,
                agentMode: isRecordAgent ? alienTaskTypeName : ''
            });
            return;
        }

        TaskLedger.markHistoryIdSeen(historyId);
        TaskLedger.markAsRefunded(submitId, amount);
        logger.info(`♻️ [积分结算] 任务取消/返还积分, submit_id=${submitId}, 返还=${amount}, 类型=${ledgerTask.taskTypeName}`);

        emitToUI({
            type: 'refund', refund: amount, billingId: ledgerTask.billingId || 'auto_catch',
            taskType: ledgerTask.taskType || 'image', taskTypeName: ledgerTask.taskTypeName || '退款任务',
            resolution: ledgerTask.resolution || '-', duration: ledgerTask.duration || 0,
            prompt: ledgerTask.prompt, timestamp: ledgerTask.timestamp,
            isAlien: false, submit_id: submitId, userMessageId: ledgerTask.userMessageId,
            agentMode: ledgerTask.agentMode
        });
        return;
    }

    // === 扣费 (Cost) ===
    if (ledgerTask) {
        // 账本有任务，正常结算
        TaskLedger.markHistoryIdSeen(historyId);
        TaskLedger.markAsBilled(submitId, amount);

        logger.info(`💸 [积分结算] 任务扣除积分, submit_id=${submitId}, 扣除=${amount}, 类型=${ledgerTask.taskTypeName}`);

        emitToUI({
            type: 'cost', deduct: amount, localCost: ledgerTask.localCost || amount,
            billingId: ledgerTask.billingId, taskType: ledgerTask.taskType, taskTypeName: ledgerTask.taskTypeName,
            resolution: ledgerTask.resolution, duration: ledgerTask.duration, prompt: ledgerTask.prompt,
            timestamp: ledgerTask.timestamp, isAlien: false, userMessageId: ledgerTask.userMessageId, submit_id: submitId,
            agentMode: ledgerTask.agentMode
        });
    } else {
        // 🌟 一刀切 Alien 判定：查不到账本，立即入未决池 + 放行 UI
        TaskLedger.markHistoryIdSeen(historyId);
        TaskLedger.addAlienBill(submitId, amount); // 被动收集用于追溯核账
        emitToUI({
            type: 'cost',
            deduct: amount,
            localCost: amount,
            billingId: '即时任务',
            taskType: alienTaskType,
            taskTypeName: alienTaskTypeName,
            prompt: record.history_group_key || '他人操作',
            timestamp: record.create_time ? record.create_time * 1000 : Date.now(),
            isAlien: true,
            submit_id: submitId,
            agentMode: isRecordAgent ? alienTaskTypeName : ''
        });
    }
}

module.exports = { init, processHistoryTasks, processCreditRecords };

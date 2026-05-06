/**
 * history_sync.js - 历史追溯与对账模块 (真理级隔离版)
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

    // 账单等待室出证
    TaskLedger.on('billReleased', ({ submitId, record }) => {
        const ledgerTask = TaskLedger.getTask(submitId);
        if (!ledgerTask) return; 

        TaskLedger.markAsBilled(submitId, record.amount || 0);
        logger.info(`💸 [积分结算] 任务扣除积分, submit_id=${submitId}, 扣除=${record.amount || 0}, 类型=${ledgerTask.taskTypeName}`);

        emitToUI({
            type: 'cost', deduct: record.amount || 0, localCost: ledgerTask.localCost || (record.amount || 0),
            billingId: ledgerTask.billingId || 'auto_catch', taskType: ledgerTask.taskType || 'image',
            taskTypeName: ledgerTask.taskTypeName, resolution: ledgerTask.resolution || '-',
            duration: ledgerTask.duration || 0, prompt: ledgerTask.prompt,
            timestamp: ledgerTask.timestamp || Date.now(), isAlien: false,
            userMessageId: ledgerTask.userMessageId || null, submit_id: submitId,
            agentMode: ledgerTask.agentMode
        });
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

// 🌟 核心：完全吸收你的旧模板精髓，坚决捍卫本地账本的最初定性！
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
    
    // 如果本地早有定论，以本地为王！
    if (ledgerTask && ledgerTask.agentMode) {
        taskTypeName = ledgerTask.agentMode; 
    } else if (isAgent) {
        taskTypeName = mode.includes('infinite') ? '无限画布 Agent' : '标准 Agent';
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

        // 🛡️ 防御：如果本地账本没这号人，就是他人的历史记录，直接当空气！
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
        // 远古账单屏蔽，只管当前周期的
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

    // === 退款 (Refund) ===
    if (record.history_type === 1) {
        if (!ledgerTask) {
            TaskLedger.markHistoryIdSeen(historyId);
            // 他人最新的取消任务，仅送给 UI 展示，绝不入账，不打印控制台！
            emitToUI({
                type: 'refund', refund: amount, billingId: 'alien_task',
                taskType: record.title?.includes('视频') ? 'video' : 'image',
                taskTypeName: record.title || '退款任务',
                prompt: record.history_group_key || '他人操作',
                isAlien: true, submit_id: submitId
            });
            return; 
        }

        TaskLedger.markHistoryIdSeen(historyId);
        TaskLedger.markAsRefunded(submitId, amount);
        logger.info(`♻️ [积分结算] 任务取消/返还积分, submit_id=${submitId}, 返还=${amount}, 原任务类型=${ledgerTask.taskTypeName}`);

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
        const unboundTasks = TaskLedger.getUnboundPendingTasks();
        if (unboundTasks.length > 0) {
            TaskLedger.addToWaitingRoom(submitId, record, (sid, rec) => {
                TaskLedger.markHistoryIdSeen(historyId);
                // 超时确认是他人账单。送给UI展示，不进账本。
                emitToUI({
                    type: 'cost', deduct: rec.amount || 0, localCost: rec.amount || 0,
                    billingId: rec.model_info?.model_req_key || 'alien_task',
                    taskType: rec.title?.includes('视频') ? 'video' : 'image',
                    taskTypeName: rec.title || '生成任务',
                    prompt: rec.history_group_key || '他人操作', 
                    timestamp: rec.create_time ? rec.create_time * 1000 : Date.now(), 
                    isAlien: true, submit_id: sid,
                });
            });
        } else {
            TaskLedger.markHistoryIdSeen(historyId);
            // 别人刚点的最新生成，仅推给UI展示
            emitToUI({
                type: 'cost', deduct: amount, localCost: amount,
                billingId: record.model_info?.model_req_key || 'alien_task',
                taskType: record.title?.includes('视频') ? 'video' : 'image', 
                taskTypeName: record.title || '生成任务',
                prompt: record.history_group_key || '他人操作', 
                timestamp: record.create_time ? record.create_time * 1000 : Date.now(),
                isAlien: true, submit_id: submitId,
            });
        }
    }
}

module.exports = { init, processHistoryTasks, processCreditRecords };
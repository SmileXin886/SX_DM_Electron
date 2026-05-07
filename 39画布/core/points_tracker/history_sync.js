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

    // 监听孤儿账单结算事件（探针已认领，30s 内加速闭环）
    TaskLedger.on('orphan:settled', ({ submitId, record }) => {
        const amount = record.amount || 0;
        const historyId = record.history_id || `${record.submit_id}_${record.create_time}`;
        const ledgerTask = TaskLedger.getTask(submitId);

        // 补全状态：标记已见 + 标记已结算
        TaskLedger.markHistoryIdSeen(historyId);
        TaskLedger.markAsBilled(submitId, amount);

        const recordTitle = record.title || '';
        const alienTaskType = recordTitle.includes('视频') ? 'video' : (recordTitle.includes('音频') ? 'audio' : 'image');
        const alienTaskTypeName = recordTitle || '标准 Agent';

        emitToUI({
            type: 'cost', deduct: amount,
            localCost: ledgerTask?.localCost || amount,
            billingId: ledgerTask?.billingId || 'auto_catch',
            taskType: ledgerTask?.taskType || alienTaskType,
            taskTypeName: ledgerTask?.taskTypeName || alienTaskTypeName,
            resolution: ledgerTask?.resolution || '-',
            duration: ledgerTask?.duration || 0,
            prompt: ledgerTask?.prompt || record.history_group_key || '标准 Agent',
            timestamp: ledgerTask?.timestamp || (record.create_time ? record.create_time * 1000 : Date.now()),
            isAlien: false,
            submit_id: submitId,
            // 🌟 submitId 作 key 建任务后，bind 必定补全 userMessageId，双 key 映射保证这里不会为空
            userMessageId: ledgerTask?.userMessageId,
            agentMode: ledgerTask?.agentMode || ''
        });
    });

    // 监听孤儿账单超时事件（30s 后确认无主，推为 Alien）
    TaskLedger.on('orphan:timeout', ({ submitId, record }) => {
        const amount = record.amount || 0;
        const historyId = record.history_id || `${record.submit_id}_${record.create_time}`;
        TaskLedger.markHistoryIdSeen(historyId);

        const recordTitle = record.title || '';
        const isRecordAgent = recordTitle.includes('Agent') || recordTitle.includes('画布') || recordTitle.includes('智能体');
        const alienTaskType = recordTitle.includes('视频') ? 'video' : (recordTitle.includes('音频') ? 'audio' : 'image');
        const alienTaskTypeName = recordTitle || '生成任务';

        emitToUI({
            type: 'cost', deduct: amount, localCost: amount,
            billingId: '即时任务',
            taskType: alienTaskType,
            taskTypeName: alienTaskTypeName,
            prompt: record.history_group_key || '他人操作',
            timestamp: record.create_time ? record.create_time * 1000 : Date.now(),
            isAlien: true, submit_id: submitId,
            agentMode: isRecordAgent ? alienTaskTypeName : ''
        });
    });

    // 🌟 VIP 快速释放通道：非 Agent 他人任务被提前判定为 Alien 时触发
    TaskLedger.on('orphan:alien_force_release', ({ submitId, record, taskInfo }) => {
        const amount = record.amount || 0;
        const recordTitle = record.title || '';
        let alienTaskType = recordTitle.includes('视频') ? 'video' : (recordTitle.includes('音频') ? 'audio' : 'image');
        let prompt = record.history_group_key || '他人操作';
        let billingId = '即时任务';

        // 🌟 提取真实的模型和提示词
        if (taskInfo) {
            if (taskInfo.generate_type === 2) alienTaskType = 'video';
            else if (taskInfo.generate_type === 3) alienTaskType = 'audio';
            prompt = extractPrompt(taskInfo) || prompt;
            billingId = taskInfo.model_info?.model_req_key || billingId;

            // 🌟 新增拦截：如果是他人任务，坚决不用 Agent 动态分配 这几个字
            if (billingId === 'Agent 动态分配' || billingId === 'alien_task') {
                billingId = '即时任务';
            }
        }

        emitToUI({
            type: 'cost', deduct: amount, localCost: amount,
            billingId: billingId,
            taskType: alienTaskType,
            taskTypeName: recordTitle || '他人生成任务',
            prompt: prompt,
            timestamp: record.create_time ? record.create_time * 1000 : Date.now(),
            isAlien: true, submit_id: submitId,
            agentMode: ''
        });
    });

    // 🌟 核心新增：监听本地账本创建事件
    TaskLedger.on('taskCreated', ({ taskKey, task }) => {
        // 只有 Agent 模式才需要"核算中"的占位显示
        if (task.agentMode || (task.taskTypeName && task.taskTypeName.includes('Agent'))) {
            emitToUI({
                type: 'pending_display', // 告诉前端这是刚捕获的待核算任务
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

    // 🌟 解析他人任务的属性，精准定位 Agent
    const recordTitle = record.title || '';
    const isRecordAgent = recordTitle.includes('Agent') || recordTitle.includes('画布') || recordTitle.includes('智能体');
    const alienTaskType = recordTitle.includes('视频') ? 'video' : (recordTitle.includes('音频') ? 'audio' : 'image');
    const alienTaskTypeName = recordTitle || '生成任务';

    // === 退款 (Refund) ===
    if (record.history_type === 1) {
        if (!ledgerTask) {
            TaskLedger.markHistoryIdSeen(historyId);
            // 他人最新的取消任务，仅送给 UI 展示，绝不入账！
            emitToUI({
                type: 'refund', refund: amount, billingId: '即时任务',
                taskType: alienTaskType,
                taskTypeName: alienTaskTypeName,
                prompt: record.history_group_key || '他人操作',
                isAlien: true, submit_id: submitId,
                agentMode: isRecordAgent ? alienTaskTypeName : '' // 让前端能识别他人Agent
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
        // 三重拦截防御：防止重复入池和轮询刷屏
        if (TaskLedger.hasOrphanBill && TaskLedger.hasOrphanBill(submitId)) return;

        // 🌟 空仓智能 0 秒放行：检查是否有"等准生证"的 Agent 任务
        const unboundTasks = TaskLedger.getUnboundPendingTasks();

        if (unboundTasks.length === 0) {
            // 家里没有正在等准生证的 Agent，陌生的 submit_id 百分之百是 Alien
            TaskLedger.markHistoryIdSeen(historyId);
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
            return;
        }

        // unboundTasks.length > 0：有 Agent 在跑，进孤儿池等 8 秒
        TaskLedger.addOrphanBill(submitId, record);
    }
}

module.exports = { init, processHistoryTasks, processCreditRecords };
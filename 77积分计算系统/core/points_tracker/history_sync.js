/**
 * history_sync.js - 历史追溯与对账模块（延迟追溯 + 严格 Alien 隔离版 + 多实例工厂模式）
 *
 * 核心原则：
 * - 放弃孤儿池缓冲机制，账单来即判定。
 * - 本地账本有任务 → 正常结算；无任务 → 立即 Alien，不等待。
 * - Agent 任务的所有扣费碎片在实时阶段全部归入 Alien，
 *   由 agent_reconciler.js 每 2 分钟统一追溯归总。
 * - 软件重启后，存量任务通过存量扫描恢复 UI 状态。
 * - 退款/结算必须结案清理（removeTask），防止重复读取。
 */
const TaskLedger = require('./task_ledger');

const logger = {
    info: (...a) => console.log('[HistorySync]', new Date().toLocaleTimeString('zh-CN', { hour12: false }), ...a),
    warn: (...a) => console.warn('[HistorySync]', ...a),
    error: (...a) => console.error('[HistorySync]', ...a),
};

/**
 * HistorySync 工厂函数
 * 为每个账号创建独立的闭包作用域
 * @param {Function} onPointsUpdate - 积分更新回调
 * @param {string} accountId - 账号 ID
 * @returns {{ processCreditRecords: Function, destroy: Function }}
 */
function setupHistorySync(onPointsUpdate, accountId) {
    let _isFirstCreditLoad = true;
    let _isInit = false;
    const _sessionStartTimeSec = Date.now() / 1000;

    function emitToUI(payload) {
        if (typeof onPointsUpdate === 'function') onPointsUpdate(payload);
    }

    /**
     * 恢复存量任务时，统统作为 pending_display 推送！
     * UI 会完美读取 taskTypeName（视频生成），且不显示任何虚假的分数！
     */
    async function syncPendingTasksFromCache() {
        try {
            if (TaskLedger.load) await TaskLedger.load();
            const pendingTasks = TaskLedger.getAllTasks ? TaskLedger.getAllTasks() : [];

            pendingTasks.forEach(task => {
                if (task.accountId === accountId) {
                    emitToUI({
                        type: 'pending_display',
                        userMessageId: task.userMessageId || task.submitId || task.taskKey,
                        submit_id: task.submitId || task.taskKey,
                        agentMode: task.agentMode,
                        taskTypeName: task.taskTypeName,
                        taskType: task.taskType || 'image',
                        prompt: task.prompt,
                        timestamp: task.timestamp,
                        status: 'pending',
                        isRecovered: true,
                        billed: task.billed // 👈 就加这一行！把账本里的扣费状态传给 UI
                    });
                }
            });
        } catch (e) {
            logger.warn('存量任务恢复失败', e.message);
        }
    }

    // 给前端留 1.5 秒的渲染时间，防止过早推送导致 UI 漏接
    setTimeout(() => {
        syncPendingTasksFromCache();
    }, 1500);

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

            // 🌟 核心修复：只处理属于当前账号的任务
            if (ledgerTask.accountId && ledgerTask.accountId !== accountId) continue;

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
            const sortedRecords = [...records].reverse();
            for (const r of sortedRecords) {
                const submitId = r.submit_id;
                const ledgerTask = submitId ? TaskLedger.getTask(submitId) : null;

                // 核心修复：防秒退漏扣！
                // 如果发现这个历史遗留任务还没被扣过费 (billed为false)，
                // 绝对不能把它吞掉，必须立刻交给 _settleSingleRecord 发送真实云端扣费给 UI！
                if (ledgerTask && !ledgerTask.billed && r.history_type !== 1) {
                    _settleSingleRecord(r);
                } else {
                    TaskLedger.markHistoryIdSeen(r.history_id || `${r.submit_id}_${r.create_time}`);
                    if (r.submit_id && r.history_type !== 1 && !ledgerTask) {
                        TaskLedger.addAlienBill(r.submit_id, r.amount || 0);
                    }
                }
            }
            _isFirstCreditLoad = false;
            return;
        }
        // ...下面原有逻辑保持不变

        const sortedRecords = [...records].reverse();
        for (const record of sortedRecords) {
            const recordTime = record.create_time || 0;
            const submitId = record.submit_id;
            const ledgerTask = submitId ? TaskLedger.getTask(submitId) : null;
            const amount = record.amount || 0;

            // 🌟 修复2：取消 session 时间硬过滤
            // 只要能匹配到本地 TaskLedger 的记录（退款或扣费），或者 amount > 0（退款），
            // 就跳过 sessionStartTimeSec 检查，确保历史任务能正常认领
            const canSkipTimeCheck = (
                // 条件1：本地账本有记录（无论退款还是扣费都认）
                (ledgerTask !== null && ledgerTask !== undefined) ||
                // 条件2：这是退款记录（amount > 0），退款必须认领
                (record.history_type === 1 && amount > 0)
            );

            if (recordTime > 0 && recordTime < _sessionStartTimeSec && !canSkipTimeCheck) {
                TaskLedger.markHistoryIdSeen(record.history_id || `${submitId}_${record.create_time}`);
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

        // 🌟 新增：如果任务属于其他账号，跳过处理
        if (ledgerTask && ledgerTask.accountId && ledgerTask.accountId !== accountId) {
            return;
        }

        const recordTitle = record.title || '';
        const isRecordAgent = recordTitle.includes('Agent') || recordTitle.includes('画布') || recordTitle.includes('智能体');
        const alienTaskType = recordTitle.includes('视频') ? 'video' : (recordTitle.includes('音频') ? 'audio' : 'image');
        const alienTaskTypeName = recordTitle || '生成任务';

        // === 退款 (Refund) ===
        if (record.history_type === 1) {
            // 🌟 修复3：完善退款认领逻辑
            // 第一步：先通过 submitId 去 TaskLedger 查
            if (ledgerTask) {
                // 第二步 a+b+c：查到了，执行结案删除 + 发送退款事件 + 日志
                TaskLedger.markHistoryIdSeen(historyId);
                TaskLedger.markAsRefunded(submitId, amount);

                // 🌟 修复5：任务结案清理 - 退款后必须 removeTask
                TaskLedger.removeTask(submitId);

                logger.info(`♻️ [积分结算] 任务取消/返还积分, submit_id=${submitId}, 返还=${amount}, 类型=${ledgerTask.taskTypeName}, 结案已清理`);

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

            // 第三步：没查到，按 Alien 处理
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

        // === 扣费 (Cost) ===
        if (ledgerTask) {
            TaskLedger.markHistoryIdSeen(historyId);

            // 🌟 防秒退漏扣核心判定
            if (!ledgerTask.billed) {
                // 情况A：防秒退漏扣！之前没扣过费，现在账单来了，执行真实扣除！
                TaskLedger.markAsBilled(submitId, amount);
                logger.info(`💸 [积分结算] 任务真实扣费 (防秒退), submit_id=${submitId}, 扣除=${amount}`);

                emitToUI({
                    type: 'cost', deduct: amount, localCost: ledgerTask.localCost || amount,
                    billingId: ledgerTask.billingId, taskType: ledgerTask.taskType, taskTypeName: ledgerTask.taskTypeName,
                    resolution: ledgerTask.resolution, duration: ledgerTask.duration, prompt: ledgerTask.prompt,
                    timestamp: ledgerTask.timestamp, isAlien: false, userMessageId: ledgerTask.userMessageId, submit_id: submitId,
                    agentMode: ledgerTask.agentMode
                });
            } else {
                // 情况B：正常挂着生成，之前已经扣费一次了（billed 为 true）
                // 保持卡片不变！！！绝对不发送 cost 事件
                logger.info(`✅ [积分结算] 任务已扣费，保持 UI 卡片不变, submit_id=${submitId}`);
            }
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

    // 监听本地账本创建事件：Agent 任务瞬间通知 UI 显示"核算中"
    const onTaskCreated = ({ taskKey, task }) => {
        // 🌟 核心：只管自己的账号
        if (task.accountId !== accountId) return;

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
    };
    TaskLedger.on('taskCreated', onTaskCreated);

    return {
        processCreditRecords,
        destroy: () => TaskLedger.off('taskCreated', onTaskCreated)
    };
}

module.exports = { setupHistorySync };

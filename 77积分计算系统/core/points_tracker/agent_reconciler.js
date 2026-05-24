/**
 * agent_reconciler.js - Agent 任务延迟追溯对账模块
 *
 * 追溯链路（本地优先，云端兜底）：
 * 1. 本地快照（LocalStorage）：读取快照 statusCode === 50 判完结
 * 2. 云端兜底（标准 Agent）：/mweb/v1/get_history_by_ids 匹配碎片
 * 3. 云端兜底（画布 Agent）：/mweb/v1/infinite_canvas/fetch_conversation
 *
 * 【多实例工厂模式】：每个 BrowserWindow 创建独立的闭包作用域
 *
 * 【架构维护记录】
 * TODO: 画布Agent模式已暂停使用，此组件暂不更新。
 * 请勿修改或破坏此处的历史逻辑。
 */
const { ipcMain } = require('electron');
const TaskLedger = require('./task_ledger');

const RECONCILE_INTERVAL_MS = 10 * 1000;

const logger = {
    info: (...a) => console.log('[Reconciler]', new Date().toLocaleTimeString('zh-CN', { hour12: false }), ...a),
    warn: (...a) => console.warn('[Reconciler]', ...a),
    error: (...a) => console.error('[Reconciler]', ...a),
};

// 全局 Map：存储每个窗口 ID 对应的 forceReconcile 函数引用
// 用于全局 IPC 监听器 `tracker:check-standard-tasks` 能够正确路由到对应窗口
const _forceReconcileMap = new Map();

/**
 * Agent 追溯对账工厂函数
 * 为每个 BrowserWindow 创建独立的闭包作用域
 * @param {BrowserWindow} win - 即梦安全浏览器窗口
 * @param {Function} onPointsUpdate - 积分更新回调
 * @param {string} accountId - 账号 ID
 * @returns {{ stop: () => void }}
 */
function setupAgentReconciler(win, onPointsUpdate, accountId) {
    let intervalId = null;

    async function safeCommand(cmd, params = {}) {
        if (win.isDestroyed()) return null;
        try { return await win.webContents.debugger.sendCommand(cmd, params); } catch (e) { return null; }
    }

    function emitToUI(payload) {
        if (typeof onPointsUpdate === 'function') onPointsUpdate(payload);
    }

    // ═══════════════════════════════════════════════════════════════
    // 第一层：本地快照（LocalStorage）
    // 读取 dreamina__aigc-data-debug-snapshots
    // 返回 { submitIds, finished }
    // ═══════════════════════════════════════════════════════════════
    async function extractSubmitIdsFromStorage(userMessageId) {
        const expr = `
            (() => {
                try {
                    const raw = localStorage.getItem('dreamina__aigc-data-debug-snapshots');
                    if (!raw) return JSON.stringify({ error: 'no_data' });
                    const data = JSON.parse(raw);
                    const task = data['${userMessageId}'];
                    if (!task) return JSON.stringify({ error: 'task_not_found' });

                    const snapshots = task.snapshots || [];
                    let isFinished = false;
                    const submitIds = [];

                    for (let i = snapshots.length - 1; i >= 0; i--) {
                        const m = snapshots[i].model;
                        if (m) {
                            // 🌟 新增：严格检查 Agent 的回复流是否全部成功完结
                            let allMessagesFinished = false;
                            let hasStreaming = false;
                            if (m.replyMessages && Array.isArray(m.replyMessages)) {
                                allMessagesFinished = m.replyMessages.length > 0 && m.replyMessages.every(msg => msg.messageStatus === 'finished_successfully');
                                hasStreaming = m.replyMessages.some(msg => msg.messageStatus === 'streaming');
                            }

                            const terminalStates = ['finished', 'failed', 'canceled', 'cancelled', 'aborted', 'error'];
                            const isAbortedOrFailed = ['failed', 'canceled', 'cancelled', 'aborted', 'error'].includes(m.taskStatus);

                            if (m.statusCode === 50 || terminalStates.includes(m.taskStatus)) {
                                // 🌟 修复：如果是被用户强行取消或失败，直接判定完结！正常的纯文本也要放行。
                                if (submitIds.length === 0) {
                                    if (isAbortedOrFailed || (allMessagesFinished && !hasStreaming)) {
                                        isFinished = true;
                                    } else {
                                        isFinished = false;
                                    }
                                } else {
                                    isFinished = true;
                                }
                            }

                            if (m.submitIdDataMap) {
                                Object.keys(m.submitIdDataMap).forEach(k => {
                                    const entry = m.submitIdDataMap[k];
                                    if (entry && entry.submitId && !submitIds.includes(entry.submitId)) {
                                        submitIds.push(entry.submitId);
                                    }
                                });
                            }
                        }
                    }
                    return JSON.stringify({ submitIds, finished: isFinished });
                } catch (e) {
                    return JSON.stringify({ error: e.message });
                }
            })()
        `;

        const res = await safeCommand('Runtime.evaluate', { expression: expr, returnByValue: true });
        if (!res || !res.result || !res.result.value) return null;

        try {
            const raw = res.result.value;
            const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (parsed.error) {
                logger.warn(`[快照] 提取失败: ${parsed.error}`);
                return null;
            }
            return parsed;
        } catch (e) { return null; }
    }

    // ═══════════════════════════════════════════════════════════════
    // 第二层：云端 DNA 追溯（标准 Agent）
    // 🌟 核心修复：采用同一种方案，task/query 和 get_history 双管齐下
    // ═══════════════════════════════════════════════════════════════
    async function queryUniversalHistoryAPI(task) {
        const userMessageId = task.userMessageId || task.taskKey;
        if (!userMessageId) return { sids: [], finished: false };

        const allLedgerTasks = TaskLedger.getAllTasks ? TaskLedger.getAllTasks() : [];
        const knownChildIds = allLedgerTasks
            .filter(t => t.userMessageId === userMessageId && t.taskKey && t.taskKey !== userMessageId)
            .map(t => t.taskKey);

        const alienIds = TaskLedger.getAlienBills();
        const queryIds = Array.from(new Set([userMessageId, ...alienIds, ...knownChildIds]));
        if (queryIds.length === 0) return { sids: [], finished: false };

        const detailExpr = `
            (async () => {
                try {
                    const queryIds = ${JSON.stringify(queryIds)};

                    // 1. 同一种方案：尝试官方最新的任务查询接口
                    const res1 = await fetch('/mweb/v1/task/query', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ submit_ids: queryIds, task_ids: queryIds })
                    }).then(r => r.json()).catch(()=>({}));

                    // 2. 兜底历史查询接口
                    const res2 = await fetch('/mweb/v1/get_history_by_ids', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ history_ids: queryIds, submit_ids: queryIds, biz_ids: queryIds })
                    }).then(r => r.json()).catch(()=>({}));

                    return JSON.stringify({ data1: res1, data2: res2 });
                } catch (e) { return JSON.stringify({ error: e.message }); }
            })()
        `;

        const detailRes = await safeCommand('Runtime.evaluate', { expression: detailExpr, returnByValue: true, awaitPromise: true });
        if (!detailRes?.result?.value) return { sids: [], finished: false };

        try {
            const detailData = JSON.parse(detailRes.result.value);
            if (detailData.error) {
                logger.warn(`[DNA] 云端请求失败: ${detailData.error}`);
                return { sids: [], finished: false };
            }

            const matchedSids = new Set();
            let isCloudFinished = false;
            let allChildrenFinished = true;
            let foundAnyChild = false;

            // 深度递归扫描，不放过任何一个角落的状态
            const processSource = (sourceData) => {
                if (!sourceData || typeof sourceData !== 'object') return;
                function scan(obj) {
                    if (!obj || typeof obj !== 'object') return;
                    for (const key in obj) {
                        const taskInfo = obj[key];
                        if (taskInfo && typeof taskInfo === 'object') {
                            const sid = taskInfo.submit_id || taskInfo.task_id || taskInfo.id || key;

                            if (sid && typeof sid === 'string' && sid.includes('-')) {
                                const sc = taskInfo.status_code || taskInfo.statusCode;
                                const ts = taskInfo.task_status || taskInfo.taskStatus;
                                const st = taskInfo.status;
                                const stStr = String(st || '').toLowerCase();

                                const isItemFinished = (
                                    Number(sc) === 50 || String(sc) === '50' ||
                                    Number(sc) === 144 || String(sc) === '144' ||
                                    Number(st) === 144 || String(st) === '144' ||
                                    ts === 'finished' ||
                                    st === 'completed' || Number(st) === 50 || String(st) === '50' ||
                                    st === 'failed' || ts === 'failed' ||
                                    stStr === 'cancelled' || stStr === 'canceled' || stStr === 'aborted' ||
                                    ts === 'canceled' || ts === 'cancelled' || ts === 'aborted' ||
                                    st === 'finished_successfully'
                                );

                                if (String(sid) === String(userMessageId)) {
                                    if (isItemFinished) isCloudFinished = true;
                                } else {
                                    const rawMeta = taskInfo.metrics_extra || taskInfo.metricsExtra;
                                    const meta = typeof rawMeta === 'string' ? JSON.parse(rawMeta) : rawMeta;
                                    if (meta?.userMessageId === userMessageId || knownChildIds.includes(String(sid))) {
                                        matchedSids.add(sid);
                                        foundAnyChild = true;
                                        if (!isItemFinished) allChildrenFinished = false;
                                    }
                                }
                            }
                            scan(taskInfo);
                        }
                    }
                }
                scan(sourceData);
            };

            processSource(detailData.data1);
            processSource(detailData.data2);

            // 如果母任务没标记完结，但底下的碎片全部认亲且完结，强制完结
            if (!isCloudFinished && foundAnyChild && allChildrenFinished) {
                isCloudFinished = true;
            }

            // 超时 10 分钟兜底
            const ledgerTask = TaskLedger.getTask(userMessageId);
            const taskAge = ledgerTask ? (Date.now() - ledgerTask.timestamp) : 0;
            if (taskAge > 10 * 60 * 1000) isCloudFinished = true;

            return { sids: Array.from(matchedSids), finished: isCloudFinished };
        } catch (e) {
            return { sids: [], finished: false };
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // 第三层：画布专项 API（已暂停，仅保留历史逻辑）
    // 调用 /mweb/v1/infinite_canvas/fetch_conversation
    // ═══════════════════════════════════════════════════════════════
    async function queryCanvasConversationAPI(task) {
        const userMessageId = task.userMessageId || task.taskKey;
        const ledgerTask = TaskLedger.getTask(userMessageId) || {};
        const projectId = task.projectId || ledgerTask.projectId;
        const conversationId = task.conversationId || ledgerTask.conversationId;

        if (!userMessageId || !projectId || !conversationId) return { sids: [], finished: false };

        const expr = `
            (async () => {
                try {
                    const res = await fetch('/mweb/v1/infinite_canvas/fetch_conversation', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'include',
                        body: JSON.stringify({
                            project_id: "${projectId}",
                            conversation_id: "${conversationId}",
                            cursor: "0", count: 50, limit: 50, offset: 0, order: "desc"
                        })
                    });
                    if (!res.ok) return JSON.stringify({ error: 'HTTP_' + res.status });
                    return JSON.stringify(await res.json());
                } catch (e) { return JSON.stringify({ error: e.message }); }
            })()
        `;

        const res = await safeCommand('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
        if (!res?.result?.value) return { sids: [], finished: false };

        try {
            const rawJson = JSON.parse(res.result.value);
            if (rawJson.error) return { sids: [], finished: false };

            const jsonStr = JSON.stringify(rawJson);
            const foundSids = new Set();
            let isCloudFinished = false;

            if (!jsonStr.includes(userMessageId)) return { sids: [], finished: false };

            function extractIds(obj) {
                if (!obj || typeof obj !== 'object') return;
                if (obj.submit_id && typeof obj.submit_id === 'string' && obj.submit_id.includes('-')) foundSids.add(obj.submit_id);
                if (obj.extra?.submit_id) foundSids.add(obj.extra.submit_id);
                for (const k in obj) extractIds(obj[k]);
            }
            extractIds(rawJson);

            let targetTurnUuid = null;
            let cloudStatus = null;

            function findTurn(obj) {
                if (!obj || typeof obj !== 'object') return;
                if (String(obj.id) === String(userMessageId) && obj.metadata?.turn_uuid) {
                    targetTurnUuid = obj.metadata.turn_uuid; return;
                }
                if (String(obj.request_message_id) === String(userMessageId)) {
                    targetTurnUuid = obj.id || obj.turn_uuid;
                    if (typeof obj.status === 'number') cloudStatus = obj.status;
                    return;
                }
                for (const k in obj) { findTurn(obj[k]); if (targetTurnUuid) return; }
            }
            findTurn(rawJson);

            if (targetTurnUuid) {
                function findStatus(obj) {
                    if (!obj || typeof obj !== 'object') return;
                    if (String(obj.id) === String(targetTurnUuid) || String(obj.turn_uuid) === String(targetTurnUuid)) {
                        if (typeof obj.status === 'number') {
                            if (cloudStatus === null || obj.status > cloudStatus) cloudStatus = obj.status;
                        }
                        if (obj.status === 'finished_successfully') cloudStatus = 2;
                    }
                    for (const k in obj) findStatus(obj[k]);
                }
                findStatus(rawJson);
            }

            if (cloudStatus === 2 || cloudStatus === 3) isCloudFinished = true;

            return { sids: Array.from(foundSids), finished: isCloudFinished };
        } catch (e) { return { sids: [], finished: false }; }
    }

    // ═══════════════════════════════════════════════════════════════
    // 归总：快照优先 + 云端兜底 + 精准核算
    // ═══════════════════════════════════════════════════════════════
    async function reconcileAgentTask(task) {
        const userMessageId = task.userMessageId || task.taskKey;
        if (!userMessageId) return;

        const originalTask = TaskLedger.getTask(userMessageId);
        const originalPrompt = originalTask?.prompt || task.prompt || '';
        const originalAgentMode = originalTask?.agentMode || task.agentMode || 'Agent 任务';
        const originalTaskType = originalTask?.taskType || task.taskType || 'image';
        const taskProjectId = originalTask?.projectId || task.projectId || null;
        const originalAccountId = originalTask?.accountId || null;

        logger.info(`[${originalAgentMode}] 开始追溯 umid=${userMessageId}`);

        // ── 快照层 ──
        const storageResult = await extractSubmitIdsFromStorage(userMessageId);
        const isFinishedByStorage = !!storageResult?.finished;
        const storageSids = storageResult?.submitIds || [];

        // ── 云端层 ──
        let isFinishedByCloud = false;
        let cloudSids = [];

        if (originalAgentMode === '画布 Agent' && taskProjectId) {
            const { sids, finished } = await queryCanvasConversationAPI({ ...task, projectId: taskProjectId });
            cloudSids = sids || [];
            isFinishedByCloud = !!finished;
        } else {
            const { sids, finished } = await queryUniversalHistoryAPI(task);
            cloudSids = sids || [];
            isFinishedByCloud = !!finished;
        }

        // 优先快照，云端兜底：打印检测路径
        if (isFinishedByStorage) {
            logger.info(`[快照] 碎片${storageSids.length}个 完结✓`);
            logger.info(`[云端] 未检测（已走快照）`);
        } else if (isFinishedByCloud) {
            logger.info(`[快照] 未检测（已走云端）`);
            logger.info(`[云端] 碎片${cloudSids.length}个 完结✓`);
        } else {
            logger.info(`[快照] 碎片${storageSids.length}个 进行中`);
            logger.info(`[云端] 碎片${cloudSids.length}个 进行中`);
        }

        // ── 合并碎片 ──
        let allSubmitIds = [...new Set([...storageSids, ...cloudSids])];
        const ledgerTask = TaskLedger.getTask(userMessageId);
        if (ledgerTask?.caughtChildIds?.length > 0) {
            allSubmitIds = [...new Set([...allSubmitIds, ...ledgerTask.caughtChildIds])];
        }

        // ⭐ 修复1：将"完结判决"逻辑提前，优先判断任务是否在快照/云端中结束
        const isGenerationFinished = isFinishedByStorage || isFinishedByCloud;

        if (allSubmitIds.length === 0) {
            // 🌟 修复：纯文本对话，或者用户强行中断的任务，只要云端/快照已宣判完结，直接放行结案！
            if (isGenerationFinished) {
                TaskLedger.createTask(userMessageId, { status: 'settled' });
                emitToUI({ type: 'agent_task_fully_settled', userMessageId });
                TaskLedger.removeTask(userMessageId);
                const source = isFinishedByStorage ? '快照' : '云端';
                logger.info(`[${originalAgentMode}] 纯对话/取消任务完结 | 无碎片 | 优先:${source}`);
                return;
            }

            // 依然没结束且没超时，耐心等
            if (Date.now() - task.timestamp > 10 * 60 * 1000) {
                TaskLedger.createTask(userMessageId, { status: 'settled' });
                emitToUI({ type: 'agent_task_fully_settled', userMessageId });
                TaskLedger.removeTask(userMessageId);
                logger.warn(`[${originalAgentMode}] 超时强制关闭`);
            }
            return;
        }

        let settledCount = 0;

        for (const sid of allSubmitIds) {
            const existingChild = TaskLedger.getTask(sid);
            if (existingChild?.agentChildBilled) continue;

            let realCost = TaskLedger.getAlienBillCost ? TaskLedger.getAlienBillCost(sid) : 0;
            if (realCost === 0 && existingChild?.billed) {
                realCost = existingChild.billedCost || existingChild.real_cost || existingChild.amount || 0;
            }

            // 🌟 修复：把 isMainTaskItself 提出来，让扣费和免费（0积分）分支都能正常访问，防止报错崩溃！
            const isMainTaskItself = String(sid) === String(userMessageId);

            if (realCost > 0) {
                if (!existingChild) TaskLedger.createTask(sid, { userMessageId, accountId: originalAccountId });

                TaskLedger.createTask(sid, {
                    billed: true, billedCost: realCost, real_cost: realCost,
                    userMessageId, agentChildBilled: true,
                    accountId: originalAccountId,
                    ...(isMainTaskItself ? {} : { status: 'settled' })
                });

                if (TaskLedger.removeAlienBill) TaskLedger.removeAlienBill(sid);

                emitToUI({
                    type: 'agent_task_settled_item',
                    submit_id: isMainTaskItself ? `${sid}-exec` : sid,
                    deduct: realCost,
                    prompt: originalPrompt,
                    agentMode: originalAgentMode,
                    taskType: originalTaskType,
                    taskTypeName: originalAgentMode,
                    userMessageId,
                    timestamp: Date.now(),
                });
                settledCount++;
                logger.info(`💸 [积分结算] 任务扣除积分, submit_id=${sid}, 扣除=${realCost}, 类型=${originalAgentMode}`);
            } else {
                // 🌟 修复：0积分任务/免费任务兜底处理。
                // 如果主任务已经宣判完结，且距离任务触发已经超过 15 秒（预留账单延迟窗口），
                // 说明没扣分就是免费的！强行展示并完结！
                const taskAge = Date.now() - (originalTask?.timestamp || task.timestamp || Date.now());

                if (isGenerationFinished && taskAge > 15 * 1000) {
                    if (!existingChild) TaskLedger.createTask(sid, { userMessageId, accountId: originalAccountId });

                    TaskLedger.createTask(sid, {
                        billed: true, billedCost: 0, real_cost: 0, // 👈 0积分入账
                        userMessageId, agentChildBilled: true,
                        accountId: originalAccountId,
                        ...(isMainTaskItself ? {} : { status: 'settled' })
                    });

                    emitToUI({
                        type: 'agent_task_settled_item',
                        submit_id: isMainTaskItself ? `${sid}-exec` : sid,
                        deduct: 0, // 👈 UI展示扣除0积分
                        prompt: originalPrompt,
                        agentMode: originalAgentMode,
                        taskType: originalTaskType,
                        taskTypeName: originalAgentMode + ' (免费)',
                        userMessageId,
                        timestamp: Date.now(),
                    });
                    settledCount++;
                    logger.info(`✅ [免费核算] 任务 0 积分放行, submit_id=${sid}, 类型=${originalAgentMode}`);
                } else {
                    if (!existingChild) TaskLedger.createTask(sid, { userMessageId, accountId: originalAccountId });
                    TaskLedger.createTask(sid, { isAlien: false, prompt: originalPrompt, accountId: originalAccountId });
                    logger.info(`[碎片] 写入账本（等待官方账单）sid=${sid}`);
                }
            }
        }

        // ── 完结判决 ──
        // 🌟 核心修复：终极防线，即使主任务说完了，碎片没扣费绝对不放行！
        let allFragmentsSettled = true;
        if (allSubmitIds.length > 0) {
            for (const sid of allSubmitIds) {
                const child = TaskLedger.getTask(sid);
                // 只要有任何一个碎片没被标记 agentChildBilled，说明云端还在跑最后流程
                if (!child || !child.agentChildBilled) {
                    allFragmentsSettled = false;
                    break;
                }
            }
        }

        if (isGenerationFinished) {
            if (allSubmitIds.length > 0 && !allFragmentsSettled) {
                logger.warn(`[拦截假完结] 主任务信号宣称完结，但存在未扣费碎片！继续坚守...`);
                // 不执行清理操作，下一轮继续追溯！
            } else {
                TaskLedger.createTask(userMessageId, { status: 'settled' });
                emitToUI({ type: 'agent_task_fully_settled', userMessageId });
                TaskLedger.removeTask(userMessageId);
                const source = isFinishedByStorage ? '快照' : '云端';
                logger.info(`[${originalAgentMode}] 任务完结 | 碎片${allSubmitIds.length}个 | 已核${allSubmitIds.length} | 优先:${source}`);
            }
        } else {
            logger.info(`[${originalAgentMode}] 监听中 | 碎片${allSubmitIds.length}个 | 已核${settledCount}`);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // 轮次调度
    // ═══════════════════════════════════════════════════════════════
    async function doReconcileRound() {
        // 🌟 1. 专门追溯 Agent 任务（包含子碎片云端认领、完结后删除母子任务）
        const pendingAgents = TaskLedger.getAgentPendingTasks().filter(t => t.accountId === accountId);
        for (const task of pendingAgents) {
            try {
                await reconcileAgentTask(task);
            } catch (e) {
                logger.error(`[Agent追溯异常] ${task.userMessageId}: ${e.message}`);
            }
        }

        // 🌟 2. 新增防线：常规任务（特别是从账本导入的），必须全部去云端查岗，完结统统删干净！

        // 【核心修复】：改用 getAllTasks 获取全量任务，不要用 getAllPendingTasks（它会漏掉已扣费的 billed 状态）
        const allTasks = TaskLedger.getAllTasks ? TaskLedger.getAllTasks().filter(t => t.accountId === accountId) : [];

        // 精准过滤：非 Agent 任务，且状态必须是 pending、confirmed 或者 billed（已记账但还没完结）
        const standardPending = allTasks.filter(t =>
            !t.agentMode &&
            !(t.taskTypeName || '').includes('Agent') &&
            (t.status === 'pending' || t.status === 'confirmed' || t.status === 'billed') // 👈 核心突破口：把 billed 加进查岗名单！
        );

        if (standardPending.length > 0) {
            // 提取所有常规任务的 ID
            const sids = standardPending.map(t => t.submitId || t.taskKey).filter(Boolean);
            if (sids.length > 0) {
                try {
                    // 调用已有的查岗函数，一旦查到完结就会触发 UI 的 '✅ 已完结' 并从账本彻底删除！
                    await checkStandardTasks({ submitIds: sids });
                } catch (e) {
                    logger.error(`[常规追溯异常] 查岗失败: ${e.message}`);
                }
            }
        }
    }

    function forceReconcile() {
        logger.info('[强制追溯] 手动触发 (winId=' + win.id + ')');
        if (intervalId) { clearInterval(intervalId); intervalId = null; }
        doReconcileRound().catch(e => logger.error('强制追溯失败:', e.message));
        intervalId = setInterval(() => doReconcileRound().catch(e => logger.error('定时追溯失败:', e.message)), RECONCILE_INTERVAL_MS);
    }

    // ── 标准任务查岗（使用本地闭包中的 safeCommand）──
    async function checkStandardTasks(data) {
        const sids = data.submitIds || [];
        if (sids.length === 0) return;

        // 🌟 同时请求 task/query (标准任务) 和 get_history_by_ids (Agent/旧任务)
        const expr = `
            (async () => {
                try {
                    const sids = ${JSON.stringify(sids)};

                    // 1. 尝试通用的任务查询接口 (官方最新的标准生图/生视频状态接口)
                    const res1 = await fetch('/mweb/v1/task/query', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ submit_ids: sids, task_ids: sids })
                    }).then(r => r.json()).catch(()=>({}));

                    // 2. 尝试历史查询接口 (兜底 Agent 分支或老接口)
                    const res2 = await fetch('/mweb/v1/get_history_by_ids', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ history_ids: sids, submit_ids: sids, biz_ids: sids })
                    }).then(r => r.json()).catch(()=>({}));

                    return JSON.stringify({ data1: res1, data2: res2 });
                } catch (e) { return JSON.stringify({ error: e.message }); }
            })()
        `;

        const res = await safeCommand('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
        if (!res?.result?.value) return;

        try {
            const detailData = JSON.parse(res.result.value);

            // 递归提取所有返回结果中的完成状态
            const checkFinished = (sourceData) => {
                const finishedIds = new Set();
                const freeIds = new Set(); // 🌟 新增：记录免单任务

                function scan(obj) {
                    if (!obj || typeof obj !== 'object') return;
                    for (const key in obj) {
                        const item = obj[key];
                        if (item && typeof item === 'object') {
                            const sid = item.submit_id || item.task_id || item.id || key;
                            const stStr = String(item.status || '').toLowerCase();
                            const tsStr = String(item.task_status || item.taskStatus || '').toLowerCase();

                            // 🌟 补全取消和失败状态，防止常规任务卡死堆积
                            const isFinished = (
                                item.status_code === 50 || item.statusCode === 50 ||
                                item.status === 144 || item.status_code === 144 || item.statusCode === 144 ||
                                tsStr === 'finished' || item.status === 50 || item.status === 'completed' ||
                                item.status === 'finished_successfully' ||
                                item.status === 'failed' || tsStr === 'failed' ||
                                stStr.includes('cancel') || tsStr.includes('cancel') ||
                                stStr.includes('abort') || tsStr.includes('abort')
                            );

                            // 🌟 核心提取：直接从云端数据识别 0 积分/免单特征
                            const isZeroCost = item.forecast_generate_cost === 0 || item.aid === 0 || (item.task && item.task.aid === 0);

                            if (isFinished && typeof sid === 'string' && sid.includes('-')) {
                                finishedIds.add(sid);
                                if (isZeroCost) freeIds.add(sid); // 🌟 抓到0积分任务！
                            }
                            scan(item);
                        }
                    }
                }
                scan(sourceData);

                finishedIds.forEach(sid => {
                    const task = TaskLedger.getTask(sid);
                    // 🌟 极简判断：只要属于某个母任务，它就是 Agent 碎片！
                    const isAgentFragment = task && task.userMessageId && task.userMessageId !== sid;

                    if (task && !isAgentFragment && !task.billed) {
                        if (freeIds.has(sid)) {
                            // 🚨 发现 0 积分任务！绝不进入 unbilled 等账单，直接发 0 元收据并销毁！
                            emitToUI({
                                type: 'cost', deduct: 0, localCost: 0,
                                billingId: task.billingId || 'free_task',
                                taskType: task.taskType || 'image',
                                taskTypeName: (task.taskTypeName || '生成任务') + ' (免单)',
                                prompt: task.prompt, timestamp: Date.now(),
                                isAlien: false, submit_id: sid
                            });
                            TaskLedger.removeTask(sid); // 彻底抹除幽灵账单
                        } else {
                            // 常规任务：还没扣费，保住一命等账单，绝对不删！
                            TaskLedger.updateTaskBySubmitId(sid, { status: 'finished_unbilled' });
                        }
                    } else {
                        // 🌟 核心恢复：Agent 碎片立刻删除变 Alien 交给巡逻兵！常规已扣费任务正常清理！
                        TaskLedger.removeTask(sid);
                        // 如果是走错片场的 Agent 碎片被干掉了，必须大声通知前端关闭母任务 UI！
                        if (isAgentFragment) {
                            emitToUI({ type: 'agent_task_fully_settled', userMessageId: task.userMessageId });
                        }
                    }
                    emitToUI({ type: 'standard_task_finished', submit_id: sid });
                });
            };

            // 两份数据都查一遍，只要发现完结就通知 UI
            checkFinished(detailData.data1);
            checkFinished(detailData.data2);
        } catch (e) {}
    }

    // 注册 IPC 监听
    ipcMain.on('tracker:force-reconcile', forceReconcile);

    // 🌟 修复：提取为具名函数，防止内存泄漏
    const checkStandardTasksHandler = async (event, data) => {
        await checkStandardTasks(data);
    };
    ipcMain.on('tracker:check-standard-tasks', checkStandardTasksHandler);

    // 将 forceReconcile 引用存入全局 Map（用于全局 IPC 路由）
    _forceReconcileMap.set(win.id, forceReconcile);

    // 立即执行一次追溯
    doReconcileRound().catch(e => logger.error('立即追溯失败:', e.message));

    // 启动定时追溯
    intervalId = setInterval(() => doReconcileRound().catch(e => logger.error('定时追溯失败:', e.message)), RECONCILE_INTERVAL_MS);

    logger.info(`追溯对账已启动（winId=${win.id}），间隔 ${RECONCILE_INTERVAL_MS / 1000}s`);

    return {
        stop: () => {
            if (intervalId) clearInterval(intervalId);
            try { ipcMain.removeListener('tracker:force-reconcile', forceReconcile); } catch (e) {}
            // 🌟 修复：窗口销毁时，精准卸载当前闭包的具名监听器，防止幽灵调用
            try { ipcMain.removeListener('tracker:check-standard-tasks', checkStandardTasksHandler); } catch (e) {}
            _forceReconcileMap.delete(win.id);
            logger.info('追溯对账已停止 (winId=' + win.id + ')');
        }
    };
}

module.exports = { setupAgentReconciler };

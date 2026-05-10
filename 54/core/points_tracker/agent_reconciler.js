/**
 * agent_reconciler.js - Agent 任务延迟追溯对账模块
 *
 * 追溯链路（本地优先，云端兜底）：
 * 1. 本地快照（LocalStorage）：读取快照 statusCode === 50 判完结
 * 2. 云端兜底（标准 Agent）：/mweb/v1/get_history_by_ids 匹配碎片
 * 3. 云端兜底（画布 Agent）：/mweb/v1/infinite_canvas/fetch_conversation
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

let _win = null;
let _onPointsUpdate = null;
let _intervalId = null;
let _isAttached = false;

function setPointsUpdateCallback(cb) { _onPointsUpdate = cb; }

async function safeCommand(cmd, params = {}) {
    if (!_isAttached || _win.isDestroyed()) return null;
    try { return await _win.webContents.debugger.sendCommand(cmd, params); } catch (e) { return null; }
}

function emitToUI(payload) {
    if (typeof _onPointsUpdate === 'function') _onPointsUpdate(payload);
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
                        // 🌟 核心修复 1：把所有可能的打断/失败状态全部加进完结名单
                        const terminalStates = ['finished', 'failed', 'canceled', 'cancelled', 'aborted', 'error'];
                        if (m.statusCode === 50 || terminalStates.includes(m.taskStatus)) {
                            isFinished = true;
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
// 调用 /mweb/v1/get_history_by_ids
// 认亲碎片，检测 status = 50 / completed / failed 等完结状态
// 返回 { sids, finished }
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
                const resp = await fetch('/mweb/v1/get_history_by_ids', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({
                        history_ids: ${JSON.stringify(queryIds)},
                        submit_ids: ${JSON.stringify(queryIds)},
                        biz_ids: ${JSON.stringify(queryIds)}
                    })
                });
                return JSON.stringify(await resp.json());
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

        const matchedSids = [];
        let isCloudFinished = false;
        let allChildrenFinished = true;
        let foundAnyChild = false;

        for (const [sid, taskInfo] of Object.entries(detailData.data || {})) {
            if (!taskInfo) continue;

            const sc = taskInfo.status_code || taskInfo.statusCode;
            const ts = taskInfo.task_status || taskInfo.taskStatus;
            const st = taskInfo.status;
            const stStr = String(st || '').toLowerCase();

            // 🌟 核心修复 2：云端状态也加入对打断的识别
            const isItemFinished = (
                sc === 50 || ts === 'finished' ||
                st === 'completed' || st === 50 ||
                st === 'failed' || ts === 'failed' ||
                stStr === 'cancelled' || stStr === 'canceled' || stStr === 'aborted' ||
                ts === 'canceled' || ts === 'cancelled' || ts === 'aborted'
            );

            if (String(sid) === String(userMessageId)) {
                if (isItemFinished) isCloudFinished = true;
            } else {
                const rawMeta = taskInfo.metrics_extra || taskInfo.metricsExtra;
                const meta = typeof rawMeta === 'string' ? JSON.parse(rawMeta) : rawMeta;
                if (meta?.userMessageId === userMessageId || knownChildIds.includes(String(sid))) {
                    matchedSids.push(sid);
                    foundAnyChild = true;
                    if (!isItemFinished) allChildrenFinished = false;
                }
            }
        }

        // 🚨 核心修复：直接删掉或注释掉下面这 3 行！
        // 禁止"目前已知子任务全完 = 主任务完结"的越权逻辑。
        // 因为 Agent 可能会连续生成，必须死死盯住主任务自身的完结信号！
        /*
        if (!isCloudFinished && foundAnyChild && allChildrenFinished) {
            isCloudFinished = true;
        }
        */

        // 兜底：超时 10 分钟 + 云端无数据，强制放行
        const ledgerTask = TaskLedger.getTask(userMessageId);
        const taskAge = ledgerTask ? (Date.now() - ledgerTask.timestamp) : 0;
        if (taskAge > 10 * 60 * 1000 && matchedSids.length === 0 && queryIds.length > 0) {
            isCloudFinished = true;
        }

        return { sids: matchedSids, finished: isCloudFinished };
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
        if (!isGenerationFinished) {
            // 如果没完结且没碎片，才走超时兜底逻辑
            if (Date.now() - task.timestamp > 10 * 60 * 1000) {
                TaskLedger.createTask(userMessageId, { status: 'settled' });
                emitToUI({ type: 'agent_task_fully_settled', userMessageId });
                logger.warn(`[${originalAgentMode}] 超时强制关闭`);
            }
            return; // 依然没结束，继续等
        } else {
            // ⭐ 修复2：如果已完结且 0 碎片（说明是纯文本对话），主动下发一条 0 积分明细
            TaskLedger.createTask(userMessageId, {
                billed: true, billedCost: 0, real_cost: 0, status: 'settled'
            });

            emitToUI({
                type: 'agent_task_settled_item',
                submit_id: `${userMessageId}-text`,
                deduct: 0, // 无扣费
                prompt: originalPrompt,
                agentMode: originalAgentMode,
                taskType: 'text', // 标记为纯文本
                taskTypeName: '纯文本对话',
                userMessageId,
                timestamp: Date.now(),
            });
            logger.info(`💸 [积分结算] 纯文本对话完结, 无扣费, 类型=${originalAgentMode}`);
        }
    }

    let settledCount = 0;

    for (const sid of allSubmitIds) {
        const existingChild = TaskLedger.getTask(sid);
        if (existingChild?.agentChildBilled) continue;

        let realCost = TaskLedger.getAlienBillCost ? TaskLedger.getAlienBillCost(sid) : 0;
        if (realCost === 0 && existingChild?.billed) {
            realCost = existingChild.billedCost || existingChild.real_cost || existingChild.amount || 0;
        }

        if (realCost > 0) {
            const isMainTaskItself = String(sid) === String(userMessageId);
            if (!existingChild) TaskLedger.createTask(sid, { userMessageId });

            TaskLedger.createTask(sid, {
                billed: true, billedCost: realCost, real_cost: realCost,
                userMessageId, agentChildBilled: true,
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
            if (!existingChild) TaskLedger.createTask(sid, { userMessageId });
            TaskLedger.createTask(sid, { isAlien: false, prompt: originalPrompt });
            logger.info(`[碎片] 写入账本（等待官方账单）sid=${sid}`);
        }
    }

    // ── 完结判决 ──
    // 这里直接复用上面提前声明好的 isGenerationFinished
    if (isGenerationFinished) {
        TaskLedger.createTask(userMessageId, { status: 'settled' });
        // 这一步会让 UI 左侧列表里的 Pending 卡片变成绿色的"✅ 已全核算"
        emitToUI({ type: 'agent_task_fully_settled', userMessageId });
        const source = isFinishedByStorage ? '快照' : '云端';
        logger.info(`[${originalAgentMode}] 任务完结 | 碎片${allSubmitIds.length}个 | 已核${allSubmitIds.length} | 优先:${source}`);
    } else {
        logger.info(`[${originalAgentMode}] 监听中 | 碎片${allSubmitIds.length}个 | 已核${settledCount}`);
    }
}

// ═══════════════════════════════════════════════════════════════
// 轮次调度
// ═══════════════════════════════════════════════════════════════
async function doReconcileRound() {
    const pendingAgents = TaskLedger.getAgentPendingTasks();
    if (pendingAgents.length === 0) return;

    for (const task of pendingAgents) {
        try {
            await reconcileAgentTask(task);
        } catch (e) {
            logger.error(`[追溯异常] ${task.userMessageId}: ${e.message}`);
        }
    }
}

function forceReconcile() {
    logger.info('[强制追溯] 手动触发');
    if (_intervalId) { clearInterval(_intervalId); _intervalId = null; }
    doReconcileRound().catch(e => logger.error('强制追溯失败:', e.message));
    _intervalId = setInterval(() => doReconcileRound().catch(e => logger.error('定时追溯失败:', e.message)), RECONCILE_INTERVAL_MS);
}

// ==========================================
// 🌟 修复：专门给普通任务 UI 提供的查岗接口（双管齐下版）
// ==========================================
ipcMain.on('tracker:check-standard-tasks', async (event, data) => {
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
            function scan(obj) {
                if (!obj || typeof obj !== 'object') return;
                for (const key in obj) {
                    const item = obj[key];
                    if (item && typeof item === 'object') {
                        const sid = item.submit_id || item.task_id || item.id || key;
                        const isFinished = (
                            item.status_code === 50 || item.statusCode === 50 ||
                            item.task_status === 'finished' || item.taskStatus === 'finished' ||
                            item.status === 50 || item.status === 'completed'
                        );
                        if (isFinished && typeof sid === 'string' && sid.includes('-')) {
                            finishedIds.add(sid);
                        }
                        scan(item);
                    }
                }
            }
            scan(sourceData);
            finishedIds.forEach(sid => {
                emitToUI({ type: 'standard_task_finished', submit_id: sid });
            });
        };

        // 两份数据都查一遍，只要发现完结就通知 UI
        checkFinished(detailData.data1);
        checkFinished(detailData.data2);
    } catch (e) {}
});

function start(win) {
    if (_isAttached) return;
    _win = win;
    _isAttached = true;
    ipcMain.on('tracker:force-reconcile', forceReconcile);
    doReconcileRound().catch(e => logger.error('立即追溯失败:', e.message));
    _intervalId = setInterval(() => doReconcileRound().catch(e => logger.error('定时追溯失败:', e.message)), RECONCILE_INTERVAL_MS);
    logger.info(`追溯对账已启动，间隔 ${RECONCILE_INTERVAL_MS / 1000}s`);
}

function stop() {
    if (_intervalId) { clearInterval(_intervalId); _intervalId = null; }
    try { ipcMain.removeListener('tracker:force-reconcile', forceReconcile); } catch (_) {}
    _isAttached = false;
    _win = null;
    _onPointsUpdate = null;
}

module.exports = { start, stop, setPointsUpdateCallback };

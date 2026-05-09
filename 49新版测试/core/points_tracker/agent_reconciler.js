/**
 * agent_reconciler.js - Agent 任务延迟追溯对账模块（本地优先 + 云端兜底版）
 *
 * ═══════════════════════════════════════════════════════════════
 * 追溯链路（本地优先，云端兜底）：
 * 1. 本地快照（LocalStorage）：
 *    读取 dreamina__aigc-data-debug-snapshots
 *    检查 snapshots 最后一条 model.statusCode === 50 判完结
 *    遍历 model.submitIdDataMap 提取子 submit_id
 *
 * 2. 云端兜底（标准 Agent）：
 *    - 把 userMessageId 本身 + TaskLedger.getAlienBills() 全部塞进查询
 *    - 调用 /mweb/v1/get_history_by_ids（credentials: 'include' 绕过风控）
 *    - 匹配 metrics_extra.userMessageId 认亲碎片
 *    - 同时查主任务的 statusCode === 50 判完结
 *
 * 3. 云端兜底（画布 Agent）：
 *    - 调用 /mweb/v1/infinite_canvas/fetch_conversation
 *    - 降维提取所有 UUID 作为候选碎片
 *    - 读取 turn.status === 2/3 判完结
 *
 * 核算：直接用 TaskLedger.getAlienBillCost(sid) 获取金额，无需再次调接口
 * 发射：逐条 emitToUI({ type: 'agent_task_settled_item', ... })
 *
 * 身份传承：从 TaskLedger 获取原始 prompt，严禁用"智能体生成"兜底
 */
const { ipcMain } = require('electron');
const TaskLedger = require('./task_ledger');

const RECONCILE_INTERVAL_MS = 2 * 60 * 1000; // 2 分钟

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
// 第一层：LocalStorage 提取 submit_ids
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

                // 🌟 核心修复：倒序遍历所有快照，只要出现过 50 即认为完结
                for (let i = snapshots.length - 1; i >= 0; i--) {
                    const m = snapshots[i].model;
                    if (m) {
                        if (m.statusCode === 50 || m.taskStatus === 'finished') isFinished = true;
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
            logger.warn(`[Storage] userMessageId=${userMessageId} 提取失败: ${parsed.error}`);
            return null;
        }
        return parsed;
    } catch (e) { return null; }
}

// ═══════════════════════════════════════════════════════════════
// 第二层：统一滴血认亲 API（增强版：云端状态感知）
// 1. 把 userMessageId 本身也塞进查询列表，查主任务自己的 statusCode
// 2. 同时做碎片认亲
// 3. 返回 { sids, finished }：碎片列表 + 主任务是否已完结 (statusCode 50)
// ═══════════════════════════════════════════════════════════════
async function queryUniversalHistoryAPI(task) {
    const userMessageId = task.userMessageId || task.taskKey;
    if (!userMessageId) return { sids: [], finished: false };

    // 🌟 核心改进：把 userMessageId 也塞进查询列表，去云端查它的状态
    const alienIds = TaskLedger.getAlienBills();
    const queryIds = Array.from(new Set([userMessageId, ...alienIds]));

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
                const json = await resp.json();
                return JSON.stringify(json);
            } catch (e) { return JSON.stringify({ error: e.message }); }
        })()
    `;

    const detailRes = await safeCommand('Runtime.evaluate', { expression: detailExpr, returnByValue: true, awaitPromise: true });
    if (!detailRes?.result?.value) return { sids: [], finished: false };

    try {
        const detailData = JSON.parse(detailRes.result.value);
        const matchedSids = [];
        let isCloudFinished = false;

        for (const [sid, taskInfo] of Object.entries(detailData.data || {})) {
            // 1. 判定主任务完结状态 (标准模式 statusCode 50 为完结)
            if (String(sid) === String(userMessageId)) {
                if (taskInfo.status_code === 50 || taskInfo.statusCode === 50) {
                    isCloudFinished = true;
                    logger.info(`[UniversalAPI] 主任务状态确认: statusCode=${taskInfo.status_code || taskInfo.statusCode}`);
                }
            }

            // 2. 碎片认亲逻辑
            const rawMeta = taskInfo.metrics_extra || taskInfo.metricsExtra;
            let meta = typeof rawMeta === 'string' ? JSON.parse(rawMeta) : rawMeta;
            if (meta?.userMessageId === userMessageId) {
                matchedSids.push(sid);
            }
        }
        return { sids: matchedSids, finished: isCloudFinished };
    } catch (e) {
        return { sids: [], finished: false };
    }
}

// ═══════════════════════════════════════════════════════════════
// 第三条线：画布专项 API（降维提取碎片 + 安全获取状态）
// 返回 { sids, finished }
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
                        cursor: "0",
                        count: 50,
                        limit: 50,
                        offset: 0,
                        order: "desc"
                    })
                });
                if (!res.ok) return JSON.stringify({ error: 'HTTP_ERROR_' + res.status });
                const json = await res.json();
                return JSON.stringify({ success: true, rawData: json });
            } catch (e) {
                return JSON.stringify({ error: e.message });
            }
        })()
    `;

    const res = await safeCommand('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });

    if (!res || !res.result || !res.result.value) return { sids: [], finished: false };

    try {
        const rawJson = JSON.parse(res.result.value);
        if (rawJson.error) return { sids: [], finished: false };

        const jsonStr = JSON.stringify(rawJson.rawData || rawJson);
        let foundSids = new Set();
        let isCloudFinished = false;

        if (jsonStr.includes(userMessageId)) {
            // 1. 🌟 修复：靶向提取真实的 submit_id，废弃暴力正则
            function extractRealSubmitIds(obj) {
                if (!obj || typeof obj !== 'object') return;

                // 只抓取明确标记为 submit_id 的字段
                if (obj.submit_id && typeof obj.submit_id === 'string' && obj.submit_id.includes('-')) {
                    foundSids.add(obj.submit_id);
                }
                // 兼容 tool_calls 结构下的 extra.submit_id
                if (obj.extra && obj.extra.submit_id) {
                    foundSids.add(obj.extra.submit_id);
                }

                for (const key in obj) {
                    extractRealSubmitIds(obj[key]);
                }
            }
            extractRealSubmitIds(rawJson);

            // 2. 🌟 双重靶向：寻找 turn_uuid 并判定状态
            let targetTurnUuid = null;
            let cloudStatus = null;

            function findTurnUuid(obj) {
                if (!obj || typeof obj !== 'object') return;
                if (String(obj.id) === String(userMessageId) && obj.metadata && obj.metadata.turn_uuid) {
                    targetTurnUuid = obj.metadata.turn_uuid;
                    return;
                }
                if (String(obj.request_message_id) === String(userMessageId)) {
                    targetTurnUuid = obj.id || obj.turn_uuid;
                    if (typeof obj.status === 'number') cloudStatus = obj.status;
                    return;
                }
                for (const key in obj) {
                    findTurnUuid(obj[key]);
                    if (targetTurnUuid) return;
                }
            }
            findTurnUuid(rawJson);

            if (targetTurnUuid) {
                function findAllNodesByTurnId(obj) {
                    if (!obj || typeof obj !== 'object') return;

                    if (String(obj.id) === String(targetTurnUuid) || String(obj.turn_uuid) === String(targetTurnUuid)) {
                        // 提取纯数字状态 (如 1, 2, 3)
                        if (typeof obj.status === 'number') {
                            if (cloudStatus === null || obj.status > cloudStatus) {
                                cloudStatus = obj.status;
                            }
                        }
                        // 🌟 核心修复：如果节点明确标示为字符串 "finished_successfully"，直接判定大轮次已完成！
                        if (obj.status === 'finished_successfully') {
                            cloudStatus = 2;
                        }
                    }

                    for (const key in obj) {
                        findAllNodesByTurnId(obj[key]);
                    }
                }
                findAllNodesByTurnId(rawJson);
            }

            // 第三步：最终判决
            if (cloudStatus === 2 || cloudStatus === 3) {
                isCloudFinished = true;
                logger.info(`[画布解析] 🎯 靶向锁定完结！状态码: ${cloudStatus}`);
            } else if (cloudStatus !== null) {
                logger.info(`[画布解析] ⏳ 仍在运行中，当前状态: ${cloudStatus}`);
            }
        }
        return { sids: Array.from(foundSids), finished: isCloudFinished };
    } catch (e) { return { sids: [], finished: false }; }
}

// ═══════════════════════════════════════════════════════════════
// 归总单个 Agent 任务（本地优先 + 云端兜底 架构）
// 追溯链路：
// 1. 本地快照（标准/画布共用，LocalStorage，优先）
// 2. 云端兜底（标准用 DNA，画布用家谱）
// ═══════════════════════════════════════════════════════════════
async function reconcileAgentTask(task) {
    const userMessageId = task.userMessageId || task.taskKey;
    if (!userMessageId) return;

    const originalTask = TaskLedger.getTask(userMessageId);
    const originalPrompt = originalTask?.prompt || task.prompt || '';
    const originalAgentMode = originalTask?.agentMode || task.agentMode || 'Agent 任务';
    const originalTaskType = originalTask?.taskType || task.taskType || 'image';
    const taskProjectId = originalTask?.projectId || task.projectId || null;

    // ── 第一步：优先查本地快照 (标准与画布共用逻辑) ──
    const storageResult = await extractSubmitIdsFromStorage(userMessageId);
    let isFinishedByStorage = !!storageResult?.finished;
    let storageSids = storageResult?.submitIds || [];

    // ── 第二步：云端查漏补缺 (标准用 DNA 查，画布用家谱查) ──
    let isFinishedByCloud = false;
    let cloudSids = [];

    if (originalAgentMode === '画布 Agent' && taskProjectId) {
        logger.info(`[追溯-家谱层] 画布模式启动 projectId=${taskProjectId}`);
        const { sids, finished } = await queryCanvasConversationAPI({ ...task, projectId: taskProjectId });
        cloudSids = sids || [];
        isFinishedByCloud = !!finished;
        if (cloudSids.length > 0) {
            logger.info(`[追溯-家谱层] 画布专项 API 识别出 ${cloudSids.length} 个 submit_id`);
        }
    } else {
        logger.info(`[追溯-DNA层] 标准 Agent 启动云端认亲...`);
        const { sids, finished } = await queryUniversalHistoryAPI(task);
        cloudSids = sids || [];
        isFinishedByCloud = !!finished;
        if (cloudSids.length > 0) {
            logger.info(`[追溯-DNA层] 统一 API 认亲到 ${cloudSids.length} 个 submit_id`);
        }
    }

    // ── 第三步：合并所有发现的碎片 ──
    let allSubmitIds = [...new Set([...storageSids, ...cloudSids])];

    // ── 额外：SSE 实时抓取的 ID（如果未来重新启用 SSE 拦截）──
    const ledgerTask = TaskLedger.getTask(userMessageId);
    if (ledgerTask?.caughtChildIds?.length > 0) {
        allSubmitIds = [...new Set([...allSubmitIds, ...ledgerTask.caughtChildIds])];
        logger.info(`[追溯-SSE层] 合并 ${ledgerTask.caughtChildIds.length} 个实时抓取 ID`);
    }

    if (allSubmitIds.length === 0) {
        // 兜底防卡死：如果超过 10 分钟依然没有任何数据，强制完结
        if (Date.now() - task.timestamp > 10 * 60 * 1000) {
            TaskLedger.createTask(userMessageId, { status: 'settled' });
            logger.warn(`[追溯] userMessageId=${userMessageId} 已超时 10 分钟，强制关闭`);
        } else {
            logger.info(`[追溯] userMessageId=${userMessageId} 暂无 submit_id，继续等待...`);
        }
        return;
    }

    logger.info(`[追溯] userMessageId=${userMessageId} | 合计归集 submit_id=${allSubmitIds.length} | 来源: 快照(${storageSids.length}) + ${originalAgentMode === '画布 Agent' ? '家谱' : 'DNA'}(${cloudSids.length})`);

    let settledCount = 0;
    let waitCount = 0;

    for (const sid of allSubmitIds) {
        const existingChild = TaskLedger.getTask(sid);

        // 如果已经打上了我们专属的结算烙印，直接跳过，绝不重复核算！
        if (existingChild && existingChild.agentChildBilled) {
            continue;
        }

        let realCost = 0;
        if (TaskLedger.getAlienBillCost) {
            realCost = TaskLedger.getAlienBillCost(sid);
        }

        if (realCost === 0 && existingChild && existingChild.billed === true) {
            realCost = existingChild.billedCost || existingChild.real_cost || existingChild.amount || 0;
        }

        if (realCost > 0) {
            // 🌟 终极修复：绕过底层新建任务丢弃属性的 Bug！
            // 1. 如果没有，先建一个空骨架
            if (!existingChild) {
                TaskLedger.createTask(sid, { userMessageId: userMessageId });
            }

            // 👇 核心修复区：识别是否为主任务本身
            const isMainTaskItself = String(sid) === String(userMessageId);

            // 2. 再调用一次，此时必定触发 Object.assign，强行注入所有结算状态！
            // 🌟 如果当前碎片就是主任务本身，绝不能把状态提前置为 settled！
            // 必须等待底部的 isGenerationFinished 逻辑去完结它，否则轮询会异常中断
            TaskLedger.createTask(sid, {
                billed: true,
                billedCost: realCost,
                real_cost: realCost,
                userMessageId: userMessageId,
                agentChildBilled: true,
                ...(isMainTaskItself ? {} : { status: 'settled' })
            });

            if (TaskLedger.removeAlienBill) TaskLedger.removeAlienBill(sid);

            // 🌟 视觉修复：如果是主任务本身，给发往 UI 的 ID 加上执行后缀，防止前端 Key 冲突导致渲染错乱
            const displaySid = isMainTaskItself ? `${sid}-exec` : sid;

            emitToUI({
                type: 'agent_task_settled_item',
                submit_id: displaySid,
                deduct: realCost,
                prompt: originalPrompt,
                agentMode: originalAgentMode,
                taskType: originalTaskType,
                taskTypeName: originalAgentMode,
                userMessageId,
                timestamp: Date.now(),
            });
            settledCount++;
        } else {
            // 同理，等待状态也要强行注入
            if (!existingChild) {
                TaskLedger.createTask(sid, { userMessageId: userMessageId });
            }
            TaskLedger.createTask(sid, {
                isAlien: false,
                prompt: originalPrompt
            });
            waitCount++;
        }
    }

    if (waitCount > 0) {
        logger.info(`⏳ [防抖等待] 已对 ${waitCount} 个识别碎片注入基因，静候官方真实账单...`);
    }

    // ── 第四步：终极完结判决 ──
    // ⚠️ 严禁使用 "已核销数量 === 碎片数量" 来判定完结！
    // 理由：Agent 可能会分批次下发 submit_id。提前完结会导致后续追加的生成任务无法追溯（逃单）。
    // 判定依据必须且只能是：1. 本地快照拿到 statusCode 50；或 2. 云端大轮次状态明确返回 2/3。

    const isGenerationFinished = isFinishedByStorage || isFinishedByCloud;

    if (isGenerationFinished) {
        // 1. 更新本地账本状态（确保重启后不再追溯）
        TaskLedger.createTask(userMessageId, { status: 'settled' });

        // 2. 补发 UI 信号，通知监控界面关掉"生成中"状态
        emitToUI({
            type: 'agent_task_fully_settled',
            userMessageId: userMessageId
        });

        const reason = isFinishedByStorage ? '本地快照' : '云端接口';
        logger.info(`✅ [核算完成] 任务完结！ umid=${userMessageId} | 判定来源: ${reason}`);
    } else {
        if (settledCount > 0) {
            logger.info(`⏳ [部分核算] 任务运行中... 目前共抓取 ${allSubmitIds.length} 个碎片，已安全核销 ${settledCount} 个`);
        } else {
            logger.info(`⏳ [监听中] 任务运行中... 目前共抓取 ${allSubmitIds.length} 个碎片，等待账单到达`);
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// 对账轮次
// ═══════════════════════════════════════════════════════════════
async function doReconcileRound() {
    const pendingAgents = TaskLedger.getAgentPendingTasks();
    if (pendingAgents.length === 0) return;

    logger.info(`[追溯轮次] 待追溯 Agent 任务数: ${pendingAgents.length}`);

    for (const task of pendingAgents) {
        try {
            await reconcileAgentTask(task);
        } catch (e) {
            logger.error(`[追溯异常] userMessageId=${task.userMessageId}:`, e.message);
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// 强制对账：用户手动触发，中断定时器并立即执行，重置定时器
// ═══════════════════════════════════════════════════════════════
function forceReconcile() {
    logger.info('[Reconciler] 用户手动强行介入追溯！');
    if (_intervalId) {
        clearInterval(_intervalId);
        _intervalId = null;
    }
    doReconcileRound().catch(e => logger.error('强制追溯失败:', e.message));
    _intervalId = setInterval(() => {
        doReconcileRound().catch(e => logger.error('定时追溯失败:', e.message));
    }, RECONCILE_INTERVAL_MS);
}

// ═══════════════════════════════════════════════════════════════
// 启动 / 停止
// ═══════════════════════════════════════════════════════════════
function start(win) {
    if (_isAttached) return;
    _win = win;
    _isAttached = true;

    ipcMain.on('tracker:force-reconcile', forceReconcile);

    doReconcileRound().catch(e => logger.error('立即追溯失败:', e.message));

    _intervalId = setInterval(() => {
        doReconcileRound().catch(e => logger.error('定时追溯失败:', e.message));
    }, RECONCILE_INTERVAL_MS);

    logger.info(`Agent 追溯对账已启动，间隔 ${RECONCILE_INTERVAL_MS / 1000}s`);
}

function stop() {
    if (_intervalId) {
        clearInterval(_intervalId);
        _intervalId = null;
    }
    try { ipcMain.removeListener('tracker:force-reconcile', forceReconcile); } catch (_) {}
    _isAttached = false;
    _win = null;
    _onPointsUpdate = null;
    logger.info('Agent 追溯对账已停止');
}

module.exports = { start, stop, setPointsUpdateCallback };

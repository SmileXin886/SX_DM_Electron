/**
 * cdp_interceptor.js - CDP 网络拦截器（极简纯净版：只推送最终状态）
 */
const Heartbeat = require('./heartbeat');
const TaskLedger = require('./task_ledger');

function parseGenerateRequest(postDataStr, submitId) {
    let taskInfo = {
        submit_id: submitId, billingId: 'auto_catch', taskType: 'image',
        taskTypeName: '生成任务', resolution: '-', duration: 0,
        prompt: '快捷生成模式', timestamp: Date.now(), billed: false,
        real_cost: 0, localCost: 5, isAlien: false,
    };
    try {
        const body = JSON.parse(postDataStr);
        const extend = body.extend || {};
        const draftContent = body.draft_content ? JSON.parse(body.draft_content) : null;
        let sceneOptions = [];
        if (body.metrics_extra) {
            const metricsExtra = JSON.parse(body.metrics_extra);
            if (metricsExtra.sceneOptions) sceneOptions = JSON.parse(metricsExtra.sceneOptions);
        }
        const firstScene = sceneOptions[0] || {};

        taskInfo.billingId = String(extend.m_video_commerce_info?.benefit_type || firstScene.reportParams?.extraVipFunctionKey || extend.root_model || 'auto_catch');
        const typeLower = (firstScene.type || '').toLowerCase();
        const draftLower = (body.draft_content || '').toLowerCase();

        if (typeLower === 'video' || draftLower.includes('gen_video') || taskInfo.billingId.includes('video') || taskInfo.billingId.includes('seedance')) {
            taskInfo.taskType = 'video'; taskInfo.taskTypeName = '视频生成';
        } else if (typeLower.includes('audio') || typeLower.includes('tts') || draftLower.includes('audio') || draftLower.includes('tts')) {
            taskInfo.taskType = 'audio'; taskInfo.taskTypeName = '音频配音';
        } else {
            taskInfo.taskType = 'image'; taskInfo.taskTypeName = '图片生成';
        }

        if (taskInfo.taskType === 'image' && draftContent) {
            taskInfo.resolution = draftContent.component_list?.[0]?.abilities?.generate?.core_param?.large_image_info?.resolution_type?.toUpperCase() || '';
        }
        if (!taskInfo.resolution) taskInfo.resolution = firstScene.resolutionType || firstScene.resolution || extend.resolution || body.resolution || '-';
        if (extend.m_video_commerce_info?.amount) {
            taskInfo.duration = Number(extend.m_video_commerce_info.amount);
        } else if (body.draft_content) {
            const msMatch = body.draft_content.match(/"duration_ms"\s*:\s*(\d+)/);
            if (msMatch) taskInfo.duration = Math.round(Number(msMatch[1]) / 1000);
        }
        const promptMatch = body.draft_content?.match(/"prompt"\s*:\s*"([^"]+)"/);
        if (promptMatch && !taskInfo.prompt.includes(promptMatch[1])) taskInfo.prompt = promptMatch[1];
        else if (draftContent) {
            if (taskInfo.taskType === 'image') taskInfo.prompt = draftContent.component_list?.[0]?.abilities?.generate?.core_param?.prompt || taskInfo.prompt;
            else if (taskInfo.taskType === 'video') taskInfo.prompt = draftContent.component_list?.[0]?.abilities?.gen_video?.text_to_video_params?.video_gen_inputs?.[0]?.prompt || taskInfo.prompt;
        }
        if (taskInfo.prompt) taskInfo.prompt = String(taskInfo.prompt).slice(0, 30);
        taskInfo.localCost = taskInfo.taskType === 'video' ? 15 : (taskInfo.taskType === 'audio' ? 2 : 5);
    } catch (e) {}
    return taskInfo;
}

function extractSubmitIdsFromText(data) {
    const results = new Set();
    const regex = /submit_id[^\w-]+([a-f0-9-]{36})/gi;
    let m;
    while ((m = regex.exec(data)) !== null) results.add(m[1]);
    return Array.from(results);
}

function extractUserMessageIdAndPrompt(postDataStr, agentMode) {
    let umId = null;
    let promptText = 'Agent 智能体生成';
    // 🌟 新增：提取会话ID和项目ID
    let conversationId = null;
    let projectId = null;

    try {
        const body = JSON.parse(postDataStr);

        // 🌟 提取全局外层 ID
        conversationId = body.conversation_id || null;
        projectId = body.project_id || body.workspace_id || null;

        if (body.messages && Array.isArray(body.messages) && body.messages.length > 0) {
            umId = body.messages[0].id;
            if (!umId && body.messages[0].metadata?.metrics_extra) {
                let extra = typeof body.messages[0].metadata.metrics_extra === 'string' ? JSON.parse(body.messages[0].metadata.metrics_extra) : body.messages[0].metadata.metrics_extra;
                umId = extra.userMessageId;

                // 🌟 如果外层没有，尝试从 metrics_extra 兜底提取
                if (!conversationId) conversationId = extra.conversationId || null;
                if (!projectId) projectId = extra.projectId || null;
            }
            try {
                if (body.messages[0].content?.content_parts?.[0]?.text) {
                    promptText = body.messages[0].content.content_parts[0].text;
                }
            } catch (e) {}
        }
    } catch (e) {}

    // 正则兜底
    if (!umId) {
        const strictUmMatch = postDataStr.match(/"userMessageId"\\?\s*:\s*\\?"([0-9a-fA-F-]{36})\\?"/i);
        if (strictUmMatch) umId = strictUmMatch[1];
    }

    return { umId, prompt: promptText, conversationId, projectId };
}

function setupCdpInterceptor(win, onPointsUpdate) {
    const logger = {
        info: (...a) => console.log('🔵 [CDP 拦截器]', new Date().toLocaleTimeString('zh-CN', { hour12: false }), ...a),
        warn: (...a) => console.warn('🟠 [CDP 拦截器]', ...a),
        error: (...a) => console.error('🔴 [CDP 拦截器]', ...a),
    };

    let attached = false, enabled = false;
    const heartbeat = new Heartbeat(win);
    onPointsUpdate({ type: 'init', winId: win.id });

    const requestIdToUserMsg = new Map();

    async function safeCommand(cmd, params = {}) {
        if (!attached || !enabled || win.isDestroyed()) return null;
        try { return await win.webContents.debugger.sendCommand(cmd, params); } catch (e) { return null; }
    }

    async function handleRequestWillBeSent(params) {
        let postDataStr = params.request.postData || '';
        if (params.request.method !== 'POST') return;
        if (!postDataStr && params.request.hasPostData) {
            try {
                const res = await safeCommand('Network.getRequestPostData', { requestId: params.requestId });
                if (res && res.postData) postDataStr = res.postData;
            } catch (e) {}
        }
        if (!postDataStr) return;

        const urlLower = params.request.url.toLowerCase();
        if (urlLower.includes('/commerce/v1/benefits/user_credit_history')) {
            heartbeat.updateTemplate(params.request.url, postDataStr, params.request.headers);
        }

        let agentMode = '';
        if (urlLower.includes('/infinite_canvas/conversation')) agentMode = '画布 Agent';
        else if (urlLower.includes('/creation_agent/v2/conversation')) agentMode = '标准 Agent';

        if (agentMode) {
            // 🌟 接收新增的 conversationId 和 projectId
            const { umId, prompt, conversationId, projectId } = extractUserMessageIdAndPrompt(postDataStr, agentMode);
            if (umId) {
                // 🌟 核心：瞬间锁死模式，并且将所有追踪证据挂载到核算ID上
                TaskLedger.createTask(umId, { 
                    agentMode, 
                    prompt: String(prompt).slice(0, 30),
                    taskTypeName: agentMode, // 强制指定！
                    conversationId: conversationId, // 🌟 挂载会话 ID
                    projectId: projectId            // 🌟 挂载项目 ID
                });
                requestIdToUserMsg.set(params.requestId, { userMessageId: umId, prompt: String(prompt).slice(0, 30), agentMode, timestamp: Date.now() });
                logger.info(`【任务识别】-> 模式: ${agentMode} | userMessageId: ${umId} | Conv: ${conversationId?.slice(0,8)}...`);
            }
        }

        const isCancel = urlLower.includes('cancel') || urlLower.includes('delete') || urlLower.includes('stop') || postDataStr.includes('"action":"cancel"');
        // 增加 queue_info
        const isPollingOrHistory = urlLower.includes('history') || urlLower.includes('query') || urlLower.includes('fetch') || urlLower.includes('queue_info');
        // 新增 telemetry 拦截，拒绝所有打点、日志、状态上报接口泄露的 submit_id 被误抓
        const isTelemetry = urlLower.includes('/log') || urlLower.includes('/tea') || urlLower.includes('metrics') || urlLower.includes('status');

        const isCanvasSubmit = urlLower.includes('submit_changeset');
        const isBlacklistedForNormal = isCanvasSubmit || urlLower.includes('infinite_canvas') || urlLower.includes('creation_agent') || isTelemetry;

        if (isCanvasSubmit) {
            // 画布提交结果上墙时，请求体必定包含 submit_id，如果有苦苦等待的画布 Agent，直接绑定！
            const ids = extractSubmitIdsFromText(postDataStr);
            const unboundAgents = TaskLedger.getUnboundPendingTasks().filter(t => t.agentMode === '画布 Agent');
            if (unboundAgents.length > 0 && ids.length > 0) {
                const targetUmId = unboundAgents[0].userMessageId;
                for (const sid of ids) {
                    TaskLedger.bindSubmitIdToUserMessageId(sid, targetUmId);
                    logger.info(`⚡ [画布上墙拦截] 抓到 submit_changeset，解救卡住的 Agent: ${targetUmId} <-> ${sid}`);
                }
            }
        } else if (!agentMode && !isPollingOrHistory && !isCancel && !isBlacklistedForNormal) {
            // 原本的普通模式抓取逻辑
            const submitRegex = /"submit_id"\s*:\s*"([^"]+)"/g;
            let match;
            while ((match = submitRegex.exec(postDataStr)) !== null) {
                const submitId = match[1];

                // 🌟🌟🌟 新增核心修复：画布 Agent Fetch 流延迟补偿 🌟🌟🌟
                // 因为前端解析 Fetch Chunk 比 CDP 的 loadingFinished 早，
                // 会导致前端发起的带有 submit_id 的子请求误触常规抓取，引发账单死锁。
                // 解决：如果当前有正在等待结果的画布 Agent，优先将该 submit_id 归属给它！
                const unboundAgents = TaskLedger.getUnboundPendingTasks().filter(t => t.agentMode === '画布 Agent');
                if (unboundAgents.length > 0) {
                    const targetUmId = unboundAgents[0].userMessageId;
                    TaskLedger.bindSubmitIdToUserMessageId(submitId, targetUmId);
                    logger.info(`⚡ [Fetch延迟截流] 拦截野生 submit_id，提前挂载到画布 Agent: ${submitId} -> ${targetUmId}`);
                    continue; // 成功截获，直接 continue，彻底跳过常规创建流程！
                }

                // 只有在没有挂起的 Agent 任务时，才真正视为用户发起的常规生成
                if (!TaskLedger.getTask(submitId)) {
                    const parsed = parseGenerateRequest(postDataStr, submitId);
                    parsed.isAlien = false;
                    TaskLedger.createTask(submitId, parsed);
                    logger.info(`🔵 [CDP 拦截器] 🎯 常规模式抓取: ${submitId}`);
                }
            }
        } else if (isCancel) {
            const ids = extractSubmitIdsFromText(postDataStr);
            for (const sid of ids) {
                TaskLedger.updateTaskBySubmitId(sid, { taskTypeName: '积分返还', taskType: 'refund', prompt: '主动取消任务' });
            }
        }
    }

    function handleEventSourceMessage(params) {
        const { requestId, data } = params;
        if (!data) return;

        // 拿到发出这个 SSE 请求时关联的 userMessageId
        const reqMeta = requestIdToUserMsg.get(requestId);
        if (!reqMeta) return;
        const umId = reqMeta.userMessageId;

        // 🌟 方案 A：严格按照无限画布 SSE JSON 结构进行精准认领
        try {
            const parsed = JSON.parse(data);

            // 1. 拦截 tool_result (终极扣量凭证)
            // 结构特征: path 包含 'content_parts/0/text' 且 op 是 'append' (或者 add)
            if (parsed.path && parsed.path.includes('content_parts/0/text')) {
                // value 可能是一个嵌套的 JSON 字符串
                const val = typeof parsed.value === 'string' ? JSON.parse(parsed.value) : parsed.value;

                if (val && val.submit_id) {
                    const sid = val.submit_id;

                    // 瞬间双向绑定！
                    TaskLedger.bindSubmitIdToUserMessageId(sid, umId);

                    // 提取真实计费模型 (benefit_type)
                    const updates = {};
                    if (val.commerce_info?.triplets?.[0]?.benefit_type) {
                        updates.billingId = val.commerce_info.triplets[0].benefit_type;
                    }
                    if (val.history_id) {
                        updates.history_id = val.history_id; // 备用
                    }

                    // 更新到本地账本
                    TaskLedger.updateTaskBySubmitId(sid, updates);
                    logger.info(`✅ [方案A-精准认领] 截获完整账单! 任务ID: ${sid} -> 核算ID: ${umId}`);
                    return; // 命中则直接返回
                }
            }

            // 2. 拦截 tool_call (提早拿到 submit_id 占位)
            // 结构特征: path 包含 'tool_calls/' 且 extra 里有 submit_id
            if (parsed.path && parsed.path.includes('tool_calls/')) {
                const val = typeof parsed.value === 'string' ? JSON.parse(parsed.value) : parsed.value;
                if (val?.extra?.submit_id) {
                    const sid = val.extra.submit_id;
                    TaskLedger.bindSubmitIdToUserMessageId(sid, umId);
                    logger.info(`⚡ [SSE流关联] tool_call 提前绑定: ${sid} -> ${umId}`);
                    return;
                }
            }

        } catch (e) {
            // JSON 解析失败属于正常情况（很多 SSE 是单纯的字符串拼接），静默跳过
        }

        // 3. 终极兜底：防止 JSON 结构变动或者残缺，用正则把数据里的 submit_id 全扫出来
        const submitIds = extractSubmitIdsFromText(data);
        for (const submitId of submitIds) {
            if (submitId) {
                TaskLedger.bindSubmitIdToUserMessageId(submitId, umId);
                // logger.info(`🔵 [CDP 拦截器] 🎯 SSE流正则兜底绑定: ${submitId} -> ${umId}`);
            }
        }
    }

    async function handleLoadingFinished(params) {
        const reqMeta = requestIdToUserMsg.get(params.requestId);
        if (!reqMeta) return; // 只处理我们标记过 userMessageId 的核心请求

        try {
            const resBody = await safeCommand('Network.getResponseBody', { requestId: params.requestId });
            if (resBody && resBody.body) {
                let text = resBody.base64Encoded ? Buffer.from(resBody.body, 'base64').toString('utf-8') : resBody.body;

                // 🌟 核心：流结束了，把文本里的 submit_id 全捞出来，强制绑定给这个 userMessageId
                const submitIds = extractSubmitIdsFromText(text);
                for (const sid of submitIds) {
                    if (sid) {
                        TaskLedger.bindSubmitIdToUserMessageId(sid, reqMeta.userMessageId);

                        // 🌟 [绝对确权纠偏] 只要流结束关联成功，它是 100% 的铁证。
                        // 强制覆盖一切可能被误抓的属性，洗掉"常规模式"的错误身份！
                        TaskLedger.updateTaskBySubmitId(sid, {
                            agentMode: reqMeta.agentMode,
                            taskTypeName: reqMeta.agentMode,
                            prompt: reqMeta.prompt
                        });
                        logger.info(`✅ [Fetch流结束认领] 100% 精准绑定并确权身份: ${sid} -> ${reqMeta.userMessageId}`);
                    }
                }
            }
        } catch (e) {
            logger.warn(`获取请求体失败 (requestId: ${params.requestId})`);
        }
        requestIdToUserMsg.delete(params.requestId);
    }

    async function handleResponseReceived(params) {
        const url = params.response.url;
        const requestId = params.requestId;

        // 🌟 [探针 A] 100% 精准认领：绝对不靠猜！从响应包里直接提取 message.id 和 submit_id 绑定！
        if (url.includes('/creation_agent/v2/conversation/fetch') || url.includes('/creation_agent/v2/conversation/query')) {
            try {
                const resBody = await safeCommand('Network.getResponseBody', { requestId });
                if (resBody && resBody.body) {
                    let text = resBody.base64Encoded ? Buffer.from(resBody.body, 'base64').toString('utf-8') : resBody.body;
                    const data = JSON.parse(text);
                    const messages = data.data?.messages || data.data?.conversation?.messages || [];

                    // 直接遍历云端返回的消息体，它自己知道自己是谁
                    for (const msg of messages) {
                        const exactUmId = msg.id; // 这就是百分百准确的 userMessageId！
                        if (!exactUmId) continue;

                        const toolCalls = msg.tool_calls || [];
                        for (const tc of toolCalls) {
                            let sid = null;
                            let realModel = null; // 新增：用于提取真实计费标识（模型名称）

                            if (tc.extra) {
                                try {
                                    const ex = typeof tc.extra === 'string' ? JSON.parse(tc.extra) : tc.extra;
                                    if (ex.submit_id) sid = ex.submit_id;
                                    if (ex.model_name) realModel = ex.model_name; // 从 JSON 中提取
                                } catch(e){}
                            }
                            if (!sid && tc.result) {
                                try {
                                    const res = typeof tc.result === 'string' ? JSON.parse(tc.result) : tc.result;
                                    if (res.submit_id) sid = res.submit_id;
                                    if (res.model_name) realModel = res.model_name; // 从 JSON 中提取
                                } catch(e){}
                            }
                            // 兜底提取：如果 extra 或 result 中没有 model_name，取工具函数的名称
                            if (!realModel) {
                                realModel = tc.name || (tc.function && tc.function.name);
                            }

                            // 只要在这一个包裹里同时拿到了，就是铁证如山，直接写进账本！
                            if (sid) {
                                logger.info(`🎯 [精准确权] 标准 Agent 子任务关联成功! 核算ID: ${exactUmId} <-> 任务ID: ${sid}`);
                                TaskLedger.bindSubmitIdToUserMessageId(sid, exactUmId);

                                // 🌟 新增核心逻辑：将抓取到的真实模型名称更新为计费标识
                                if (realModel) {
                                    TaskLedger.updateTaskBySubmitId(sid, { billingId: realModel });
                                }
                            }
                        }
                    }
                }
            } catch (e) {}
        }

        // 🌟 [探针 B] v2.0 终极对账：画布 Agent 历史拉取
        if (url.includes('/mweb/v1/infinite_canvas/fetch_conversation') || url.includes('/mweb/v1/infinite_canvas/get_conversation_list')) {
            try {
                const resBody = await safeCommand('Network.getResponseBody', { requestId });
                if (resBody && resBody.body) {
                    let text = resBody.base64Encoded ? Buffer.from(resBody.body, 'base64').toString('utf-8') : resBody.body;
                    const data = JSON.parse(text);
                    const messages = data.data?.messages || data.data?.conversation?.messages || [];

                    for (const msg of messages) {
                        const exactUmId = msg.id; // 这就是最确定的 userMessageId
                        if (!exactUmId) continue;

                        const toolCalls = msg.tool_calls || [];
                        for (const tc of toolCalls) {
                            let sid = tc.result?.submit_id || tc.extra?.submit_id;
                            let realModel = tc.result?.commerce_info?.triplets?.[0]?.benefit_type || tc.extra?.benefit_type;

                            if (sid) {
                                logger.info(`🎯 [历史对账闭环] 核算ID: ${exactUmId} <-> 任务ID: ${sid}`);
                                TaskLedger.bindSubmitIdToUserMessageId(sid, exactUmId);

                                // 🌟 [绝对确权纠偏] 历史拉取是最高优先级证据，强制洗掉"常规模式"的错误身份！
                                const agentTask = TaskLedger.getTask(exactUmId);
                                if (agentTask && agentTask.agentMode) {
                                    TaskLedger.updateTaskBySubmitId(sid, {
                                        agentMode: agentTask.agentMode,
                                        taskTypeName: agentTask.agentMode,
                                        prompt: agentTask.prompt
                                    });
                                }

                                if (realModel) {
                                    TaskLedger.updateTaskBySubmitId(sid, { billingId: realModel });
                                }
                                // 如果账单先到了被卡在孤儿池，这里立刻触发结算
                                if (TaskLedger.hasOrphanBill && TaskLedger.hasOrphanBill(sid)) {
                                    TaskLedger.checkAndSettleOrphanBill(sid);
                                }
                            }
                        }
                    }
                }
            } catch(e) {}
        }

        if (url.includes('/commerce/v1/benefits/user_credit_history')) {
            try {
                const resBody = await safeCommand('Network.getResponseBody', { requestId });
                if (resBody && resBody.body) {
                    let bodyText = resBody.base64Encoded ? Buffer.from(resBody.body, 'base64').toString('utf-8') : resBody.body;
                    const data = JSON.parse(bodyText);
                    const records = data.data?.records || [];
                    const totalCredit = data.data?.total_credit || 0;

                    if (records.length > 0) {
                        // 🌟🌟🌟 新增核心修复：切页/离线流失兜底认领 🌟🌟🌟
                        // 应对用户切走页面导致流中断，只产生扣费记录却无人认领的情况
                        const pendingAgents = TaskLedger.getUnboundPendingTasks().filter(t => t.agentMode);

                        if (pendingAgents.length > 0) {
                            // 按时间先后排序，优先救捞最早挂起的任务
                            pendingAgents.sort((a, b) => a.timestamp - b.timestamp);

                            for (const record of records) {
                                if (record.history_type !== 2) continue; // 只处理扣量账单
                                const sid = record.submit_id;
                                const recordTime = record.create_time * 1000;

                                // 如果本地压根不认识这个 submit_id，说明它的流被切页干碎了！
                                if (sid && !TaskLedger.getTask(sid)) {
                                    // 寻找时间匹配的挂起任务（例如：发起时间与扣费时间相差不超过 3 分钟）
                                    // 3分钟是考虑到后台排队生成的极限时间
                                    const targetAgent = pendingAgents.find(agent => 
                                        Math.abs(recordTime - agent.timestamp) < 3 * 60 * 1000
                                    );

                                    if (targetAgent) {
                                        logger.warn(`🚑 [切页兜底认领] 捕获到流失的账单，强行指派! 任务ID: ${sid} -> 核算ID: ${targetAgent.userMessageId}`);

                                        // 1. 瞬间强行确权，双向绑定！
                                        TaskLedger.bindSubmitIdToUserMessageId(sid, targetAgent.userMessageId);

                                        // 2. 补全缺失的信息，洗掉它可能被当成 Alien 任务的嫌疑
                                        TaskLedger.updateTaskBySubmitId(sid, {
                                            agentMode: targetAgent.agentMode,
                                            taskTypeName: targetAgent.agentMode + ' (云端验证)',
                                            prompt: targetAgent.prompt,
                                            billingId: record.benefit_type || record.title || 'auto_catch'
                                        });
                                    }
                                }
                            }
                        }

                        // 原本的同步结算逻辑保持不变，此时野孩子已经有了身份，能被正常结算！
                        const HistorySync = require('./history_sync');
                        HistorySync.processCreditRecords(records);
                    }
                    if (totalCredit > 0) {
                        onPointsUpdate({ type: 'sync', currentPoints: totalCredit });
                    }
                }
            } catch (e) {
                logger.error('积分账单拦截失败', e);
            }
        }

        // 🌟 [探针 A-终极形态] 死盯 history 接口，这里藏着标准 Agent 的生死簿！
        if (url.includes('/get_history_by_ids') || url.includes('/v1/get_history')) {
            try {
                const resBody = await safeCommand('Network.getResponseBody', { requestId });
                if (resBody && resBody.body) {
                    let text = resBody.base64Encoded ? Buffer.from(resBody.body, 'base64').toString('utf-8') : resBody.body;
                    const data = JSON.parse(text);

                    if (data.data) {
                        for (const [submitId, task] of Object.entries(data.data)) {
                            if (task.metrics_extra) {
                                try {
                                    const extra = typeof task.metrics_extra === 'string' ? JSON.parse(task.metrics_extra) : task.metrics_extra;
                                    if (extra.userMessageId) {
                                        const existingSubmit = TaskLedger.getTask(submitId);
                                        const existingUm = TaskLedger.getTask(extra.userMessageId);

                                        if (!existingSubmit && !existingUm) continue; // 别人电脑上的 Agent 任务，防盗门

                                        if (existingSubmit && existingSubmit.userMessageId === extra.userMessageId) {
                                            TaskLedger.checkAndSettleOrphanBill(submitId);
                                            continue;
                                        }

                                        logger.info(`✅ [探针 A 触发] 证据链闭环！任务 ID: ${submitId}`);
                                        TaskLedger.bindSubmitIdToUserMessageId(submitId, extra.userMessageId);
                                        TaskLedger.checkAndSettleOrphanBill(submitId);
                                    } else {
                                        // 🌟 修复Bug：普通任务有 metrics_extra 但无 userMessageId，必须走 VIP 释放！
                                        if (!TaskLedger.getTask(submitId) && TaskLedger.hasOrphanBill && TaskLedger.hasOrphanBill(submitId)) {
                                            TaskLedger.forceSettleAlienOrphan(submitId, task);
                                        }
                                    }
                                } catch (e) {
                                    logger.warn(`解析 metrics_extra 失败: ${submitId}`);
                                }
                            } else {
                                // 🌟 VIP 快速释放通道：这是一个明确的非 Agent 任务（没有 metrics_extra）
                                // 如果本地账本没有它，那它绝对是 Alien 任务！
                                // 如果它恰好为了防误杀被困在孤儿池里，立刻把它放出来！
                                if (!TaskLedger.getTask(submitId) && TaskLedger.hasOrphanBill && TaskLedger.hasOrphanBill(submitId)) {
                                    TaskLedger.forceSettleAlienOrphan(submitId, task);
                                }
                            }
                        }
                    }
                }
            } catch (e) {
                // 有些 options 请求没有 body，静默吞掉异常
            }
        }
    }

    function onDebuggerMessage(event, method, params) {
        if (method === 'Network.requestWillBeSent') handleRequestWillBeSent(params);
        else if (method === 'Network.responseReceived') handleResponseReceived(params);
        else if (method === 'Network.eventSourceMessageReceived') handleEventSourceMessage(params);
        else if (method === 'Network.loadingFinished') handleLoadingFinished(params);
    }

    try { win.webContents.debugger.attach('1.3'); attached = true; } catch (err) { return { detach: () => {} }; }
    win.webContents.debugger.on('message', onDebuggerMessage);
    win.webContents.debugger.sendCommand('Network.enable').then(() => enabled = true);

    function detach() {
        if (!attached) return;
        try { win.webContents.debugger.off('message', onDebuggerMessage); win.webContents.debugger.detach(); } catch (e) {}
        heartbeat.destroy(); requestIdToUserMsg.clear(); attached = false; enabled = false;
        logger.info('CDP 拦截器已销毁');
    }
    return { detach };
}
module.exports = { setupCdpInterceptor };
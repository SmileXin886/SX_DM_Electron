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
    try {
        const body = JSON.parse(postDataStr);
        if (body.messages && Array.isArray(body.messages) && body.messages.length > 0) {
            umId = body.messages[0].id;
            if (!umId && body.messages[0].metadata?.metrics_extra) {
                let extra = typeof body.messages[0].metadata.metrics_extra === 'string' ? JSON.parse(body.messages[0].metadata.metrics_extra) : body.messages[0].metadata.metrics_extra;
                umId = extra.userMessageId;
            }
            try {
                if (body.messages[0].content?.content_parts?.[0]?.text) {
                    promptText = body.messages[0].content.content_parts[0].text;
                }
            } catch (e) {}
        }
    } catch (e) {}
    if (!umId) {
        const strictUmMatch = postDataStr.match(/"userMessageId"\\?\s*:\s*\\?"([0-9a-fA-F-]{36})\\?"/i);
        if (strictUmMatch) umId = strictUmMatch[1];
    }
    return { umId, prompt: promptText };
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

    // 🚫 删除了向 UI 推送 'pending' 和 'taskUpdated' 的冗余代码！
    // 任务的扣费和返还完全交由 history_sync 里的 processCreditRecords 去判断和推送！

    async function safeCommand(cmd, params = {}) {
        if (!attached || !enabled || win.isDestroyed()) return null;
        try { return await win.webContents.debugger.sendCommand(cmd, params); } catch (e) { return null; }
    }

    async function parseHistoryByIdsResponse(requestId) {
        const resBody = await safeCommand('Network.getResponseBody', { requestId });
        if (!resBody || !resBody.body) return { tasks: [] };
        let bodyText = resBody.base64Encoded ? Buffer.from(resBody.body, 'base64').toString('utf-8') : resBody.body;
        try {
            const data = JSON.parse(bodyText);
            const tasks = [];
            if (data && data.data) {
                for (const [rawKey, task] of Object.entries(data.data)) {
                    if (!rawKey || rawKey === 'undefined') continue;
                    tasks.push(task);
                }
            }
            return { tasks };
        } catch (e) { return { tasks: [] }; }
    }

    async function parseCreditHistoryResponse(requestId) {
        const resBody = await safeCommand('Network.getResponseBody', { requestId });
        if (!resBody || !resBody.body) return { records: [], totalCredit: 0 };
        let bodyText = resBody.base64Encoded ? Buffer.from(resBody.body, 'base64').toString('utf-8') : resBody.body;
        try {
            const data = JSON.parse(bodyText);
            return { records: data.data?.records || [], totalCredit: data.data?.total_credit || 0 };
        } catch (e) { return { records: [], totalCredit: 0 }; }
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
        if (urlLower.includes('/infinite_canvas/conversation')) agentMode = '无限画布 Agent';
        else if (urlLower.includes('/creation_agent/v2/conversation')) agentMode = '标准 Agent';

        if (agentMode) {
            const { umId, prompt } = extractUserMessageIdAndPrompt(postDataStr, agentMode);
            if (umId) {
                // 🌟 核心：瞬间锁死模式，并且明确指定 taskTypeName，拒绝后端乱篡改
                TaskLedger.createTask(umId, { 
                    agentMode, 
                    prompt: String(prompt).slice(0, 30),
                    taskTypeName: agentMode // 强制指定！
                });
                requestIdToUserMsg.set(params.requestId, { userMessageId: umId, prompt: String(prompt).slice(0, 30), agentMode, timestamp: Date.now() });
                logger.info(`【任务识别】-> 模式: ${agentMode} | userMessageId: ${umId} | 内容: ${String(prompt).slice(0, 20)}`);
            }
        }

        const isCancel = urlLower.includes('cancel') || urlLower.includes('delete') || urlLower.includes('stop') || postDataStr.includes('"action":"cancel"');
        const submitRegex = /"submit_id"\s*:\s*"([^"]+)"/g;
        let match;
        while ((match = submitRegex.exec(postDataStr)) !== null) {
            const submitId = match[1];
            const parsed = parseGenerateRequest(postDataStr, submitId);

            if (isCancel) {
                TaskLedger.updateTaskBySubmitId(submitId, { taskTypeName: '积分返还', taskType: 'refund', prompt: '主动取消任务' });
            } else {
                const existing = TaskLedger.getTask(submitId);
                if (existing) {
                    TaskLedger.updateTaskBySubmitId(submitId, {
                        taskType: parsed.taskType, taskTypeName: parsed.taskTypeName, billingId: parsed.billingId,
                        resolution: parsed.resolution, duration: parsed.duration, localCost: parsed.localCost, prompt: parsed.prompt,
                    });
                } else {
                    TaskLedger.createTask(submitId, {
                        submitId: submitId, agentMode: '', prompt: parsed.prompt,
                        taskType: parsed.taskType, taskTypeName: parsed.taskTypeName, billingId: parsed.billingId,
                        resolution: parsed.resolution, duration: parsed.duration, localCost: parsed.localCost,
                    });
                    TaskLedger.bindSubmitIdToUserMessageId(submitId, submitId);
                    logger.info(`[本地识别] 🎯 常规模式抓取，瞬间锁定任务并确权: ${submitId}`);
                }
            }
        }
    }

    function handleEventSourceMessage(params) {
        const { requestId, data } = params;
        if (!data || !data.includes('submit_id')) return;
        const reqMeta = requestIdToUserMsg.get(requestId);
        if (!reqMeta) return;

        const umId = reqMeta.userMessageId;
        const submitIds = extractSubmitIdsFromText(data);
        for (const submitId of submitIds) {
            TaskLedger.bindSubmitIdToUserMessageId(submitId, umId);
            logger.info(`[SSE 出证] 绑定 submitId → userMessageId: ${submitId} → ${umId}`);
        }
    }

    async function handleLoadingFinished(params) {
        const resBody = await safeCommand('Network.getResponseBody', { requestId: params.requestId });
        if (!resBody || !resBody.body) return;
        let bodyText = resBody.base64Encoded ? Buffer.from(resBody.body, 'base64').toString('utf-8') : resBody.body;
        const submitIds = extractSubmitIdsFromText(bodyText);
        const reqMeta = requestIdToUserMsg.get(params.requestId);

        for (const submitId of submitIds) {
            if (reqMeta) {
                TaskLedger.bindSubmitIdToUserMessageId(submitId, reqMeta.userMessageId);
            }
        }
        requestIdToUserMsg.delete(params.requestId);
    }

    async function handleResponseReceived(params) {
        const url = params.response.url;
        const requestId = params.requestId;

        if (url.includes('/mweb/v1/infinite_canvas/fetch_conversation') || url.includes('/mweb/v1/infinite_canvas/get_conversation_list')) {
            const resBody = await safeCommand('Network.getResponseBody', { requestId });
            if (resBody && resBody.body) {
                let text = resBody.base64Encoded ? Buffer.from(resBody.body, 'base64').toString('utf-8') : resBody.body;
                try {
                    const data = JSON.parse(text);
                    const messages = data.data?.messages || (data.data?.conversation?.messages) || [];
                    for (const msg of messages) {
                        const umId = msg.id;
                        const toolCalls = msg.tool_calls || [];
                        for (const tc of toolCalls) {
                            const sid = tc.result?.submit_id || tc.extra?.submit_id;
                            if (umId && sid) {
                                TaskLedger.bindSubmitIdToUserMessageId(sid, umId);
                            }
                        }
                    }
                } catch(e) {}
            }
        }

        if (url.includes('/mweb/v1/get_history_by_ids')) {
            const { tasks } = await parseHistoryByIdsResponse(requestId);
            if (tasks.length > 0) {
                const HistorySync = require('./history_sync');
                HistorySync.processHistoryTasks(tasks);
            }
        }

        if (url.includes('/commerce/v1/benefits/user_credit_history')) {
            const { records, totalCredit } = await parseCreditHistoryResponse(requestId);
            if (records.length > 0) {
                onPointsUpdate({ type: 'sync', currentPoints: totalCredit });
                const HistorySync = require('./history_sync');
                HistorySync.processCreditRecords(records);
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
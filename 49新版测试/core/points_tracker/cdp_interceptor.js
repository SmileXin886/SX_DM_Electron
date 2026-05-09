/**
 * cdp_interceptor.js - CDP 网络拦截器（极简版）
 *
 * 职责边界（严格限制）：
 * - 只负责普通任务的 submit_id 瞬间抓取
 * - 只负责 Agent 任务 userMessageId 的初次记录
 * - 不参与任何 submit_id 的后续绑定（全部交给 agent_reconciler.js 2分钟延迟追溯）
 *
 * 以下逻辑已废除：
 * - SSE 流实时绑定（handleEventSourceMessage 清空）
 * - Loading 响应兜底绑定（handleLoadingFinished 清空）
 * - 探针 A/B/A-终极形态（全部删除）
 * - 画布 Agent Fetch 流延迟补偿（已删除）
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

function extractUserMessageIdAndPrompt(postDataStr) {
    let umId = null;
    let promptText = 'Agent 智能体生成';
    let conversationId = null;
    let projectId = null;

    try {
        const body = JSON.parse(postDataStr);
        conversationId = body.conversation_id || null;
        projectId = body.project_id || body.workspace_id || null;

        if (body.messages && Array.isArray(body.messages) && body.messages.length > 0) {
            umId = body.messages[0].id;
            if (!umId && body.messages[0].metadata?.metrics_extra) {
                const extra = typeof body.messages[0].metadata.metrics_extra === 'string'
                    ? JSON.parse(body.messages[0].metadata.metrics_extra)
                    : body.messages[0].metadata.metrics_extra;
                umId = extra.userMessageId;
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

    if (!umId) {
        const m = postDataStr.match(/"userMessageId"\\?\s*:\s*\\?"([0-9a-fA-F-]{36})\\?"/i);
        if (m) umId = m[1];
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

        // 心跳保活模板注入
        if (urlLower.includes('/commerce/v1/benefits/user_credit_history')) {
            heartbeat.updateTemplate(params.request.url, postDataStr, params.request.headers);
        }

        // Agent 任务识别：只负责记录 userMessageId，submit_id 的绑定全部交给 agent_reconciler.js
        let agentMode = '';
        let isCanvas = false;
        if (urlLower.includes('/infinite_canvas/conversation')) {
            agentMode = '画布 Agent';
            isCanvas = true;
        } else if (urlLower.includes('/creation_agent/v2/conversation')) {
            agentMode = '标准 Agent';
        }

        if (agentMode) {
            const { umId, prompt, conversationId, projectId } = extractUserMessageIdAndPrompt(postDataStr);
            if (umId) {
                // 🌟 画布模式：必须确保 projectId 存入账本，这是家谱追溯的钥匙
                if (isCanvas) {
                    let storedProjectId = projectId;
                    if (!storedProjectId) {
                        const pidMatch = postDataStr.match(/"project_id"\s*:\s*"([^"]+)"/);
                        if (pidMatch) storedProjectId = pidMatch[1];
                    }
                    TaskLedger.createTask(umId, {
                        agentMode,
                        prompt: String(prompt).slice(0, 30),
                        taskTypeName: agentMode,
                        conversationId,
                        projectId: storedProjectId,
                    });
                    logger.info(`[画布任务识别] -> umid: ${umId} | project: ${storedProjectId} | conv: ${conversationId}`);
                } else {
                    TaskLedger.createTask(umId, {
                        agentMode,
                        prompt: String(prompt).slice(0, 30),
                        taskTypeName: agentMode,
                        conversationId,
                        projectId,
                    });
                    logger.info(`【任务识别】-> 模式: ${agentMode} | userMessageId: ${umId}`);
                }
            }
            return; // Agent 请求处理完毕，不再走下面的普通抓取逻辑
        }

        // 以下全部是普通任务（非 Agent）的处理逻辑

        const isCancel = urlLower.includes('cancel') || urlLower.includes('delete') || urlLower.includes('stop') || postDataStr.includes('"action":"cancel"');
        const isPollingOrHistory = urlLower.includes('history') || urlLower.includes('query') || urlLower.includes('fetch') || urlLower.includes('queue_info');
        const isTelemetry = urlLower.includes('/log') || urlLower.includes('/tea') || urlLower.includes('metrics') || urlLower.includes('status');
        const isAgentRelated = urlLower.includes('infinite_canvas') || urlLower.includes('creation_agent');

        if (isCancel) {
            const ids = extractSubmitIdsFromText(postDataStr);
            for (const sid of ids) {
                TaskLedger.updateTaskBySubmitId(sid, { taskTypeName: '积分返还', taskType: 'refund', prompt: '主动取消任务' });
            }
            return;
        }

        if (isPollingOrHistory || isTelemetry || isAgentRelated) return;

        // 普通生成任务瞬间抓取
        const submitRegex = /"submit_id"\s*:\s*"([^"]+)"/g;
        let match;
        while ((match = submitRegex.exec(postDataStr)) !== null) {
            const submitId = match[1];
            if (!TaskLedger.getTask(submitId)) {
                const parsed = parseGenerateRequest(postDataStr, submitId);
                parsed.isAlien = false;
                TaskLedger.createTask(submitId, parsed);
                logger.info(`🔵 [CDP 拦截器] 🎯 常规模式抓取: ${submitId}`);
            }
        }
    }

    // 已清空：SSE 流实时绑定全部废除，交给 agent_reconciler.js 2分钟延迟追溯
    function handleEventSourceMessage(params) {
        return;
    }

    // 已清空：Loading 响应兜底绑定全部废除，交给 agent_reconciler.js 2分钟延迟追溯
    async function handleLoadingFinished(params) {
        return;
    }

    async function handleResponseReceived(params) {
        const url = params.response.url;
        const requestId = params.requestId;

        // 只保留积分账单拦截，所有找不到账本的 submit_id 立即归为 Alien
        if (url.includes('/commerce/v1/benefits/user_credit_history')) {
            try {
                const resBody = await safeCommand('Network.getResponseBody', { requestId });
                if (resBody && resBody.body) {
                    let bodyText = resBody.base64Encoded ? Buffer.from(resBody.body, 'base64').toString('utf-8') : resBody.body;
                    const data = JSON.parse(bodyText);
                    const records = data.data?.records || [];
                    const totalCredit = data.data?.total_credit || 0;

                    if (records.length > 0) {
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
        heartbeat.destroy(); attached = false; enabled = false;
        logger.info('CDP 拦截器已销毁');
    }
    return { detach };
}
module.exports = { setupCdpInterceptor };

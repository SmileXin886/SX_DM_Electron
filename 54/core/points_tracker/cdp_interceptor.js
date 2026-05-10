/**
 * cdp_interceptor.js - CDP 网络拦截器（极简版）
 *
 * ═══════════════════════════════════════════════════════════════════
 * 职责边界（严格限制）：
 * - 只负责普通任务的 submit_id 瞬间抓取
 * - 只负责 Agent 任务 userMessageId 的初次记录
 * - 不参与任何 submit_id 的后续绑定（全部交给 agent_reconciler.js 2分钟延迟追溯）
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

    // 🌟 新增：用来暂存 requestId 和 URL 映射关系的容器
    const responseUrlMap = new Map();

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
                // 1. 🌟 画布 Agent 幽灵拦截：拿到 umId 实锤后，直接丢弃，绝对不入账本！
                if (isCanvas) {
                    logger.warn(`🛑 [精准狙击] 拦截到画布 Agent 假请求，物理抹杀，不入账本！`);
                    return; 
                } 
                
                // 2. 🌟 标准 Agent 正常记账：只有标准模式才放行入账
                if (agentMode === '标准 Agent') {
                    TaskLedger.createTask(umId, {
                        agentMode,
                        prompt: String(prompt).slice(0, 30),
                        taskTypeName: agentMode,
                        conversationId,
                        projectId,
                    });
                    logger.info(`🎯 [Agent任务识别] 模式: ${agentMode} | userMessageId: ${umId}`);
                }
            }
            return; // Agent 请求处理完毕
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

        // 👇 🌟 终极真伪鉴定门：吸收前端智慧，无视假任务和报错日志 👇
        // 真实的生图/生视频请求，URL 必须明确带有 generate/submit/task，或者 Payload 里必须包含 draft_content/sceneOptions
        const isRealGenerateApi = urlLower.includes('/generate') || urlLower.includes('/submit') || urlLower.includes('/task');
        const hasGenerationDNA = postDataStr.includes('"draft_content"') || postDataStr.includes('"sceneOptions"');
        
        if (!isRealGenerateApi && !hasGenerationDNA) {
            // 这绝对是一条前端发出的垃圾报错日志，就算里面带有 submit_id 也不准抓！直接丢弃！
            return; 
        }
        // 👆 🌟 终极鉴定结束 👆

        // 普通生成任务瞬间抓取
        const submitRegex = /"submit_id"\s*:\s*"([^"]+)"/g;
        let match;
        while ((match = submitRegex.exec(postDataStr)) !== null) {
            const submitId = match[1];
            if (!TaskLedger.getTask(submitId)) {
                const parsed = parseGenerateRequest(postDataStr, submitId);
                parsed.isAlien = false;
                TaskLedger.createTask(submitId, parsed);
                // 【核心优化：日志说人话】
                logger.info(`🎯 [常规任务捕获] 发现任务 submit_id: ${submitId} | 任务类型: ${parsed.taskTypeName}`);
            }
        }
    }

    function handleEventSourceMessage(params) {
        try {
            if (!params || !params.data) return;
            const obj = JSON.parse(params.data);

            const finishedIds = new Set();
            function scanForFinished(o) {
                if (!o || typeof o !== 'object') return;
                for (const key in o) {
                    const item = o[key];
                    if (item && typeof item === 'object') {
                        const sid = item.submit_id || item.id || key;
                        const isFinished = (
                            item.status_code === 50 || item.statusCode === 50 ||
                            item.task_status === 'finished' || item.taskStatus === 'finished' ||
                            item.status === 50 || item.status === 'completed' ||
                            item.status === 'finished_successfully'
                        );
                        if (isFinished && typeof sid === 'string' && sid.includes('-')) {
                            finishedIds.add(sid);
                        }
                        scanForFinished(item);
                    }
                }
            }
            scanForFinished(obj);

            finishedIds.forEach(sid => {
                onPointsUpdate({ type: 'standard_task_finished', submit_id: sid });
            });
        } catch (e) {}
    }
    // 🌟 修复：收到响应头时，只把 URL 存起来，绝对不去读 Body！
    function handleResponseReceived(params) {
        responseUrlMap.set(params.requestId, params.response.url);
    }

    // 🌟 修复：等彻底下载完毕后，再安安心心地解析 Body 数据！
    async function handleLoadingFinished(params) {
        const requestId = params.requestId;
        const url = responseUrlMap.get(requestId);
        if (!url) return;
        responseUrlMap.delete(requestId); // 用完就删，防止内存泄漏

        // 1. 积分账单拦截（保持原样）
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
                    if (totalCredit > 0) onPointsUpdate({ type: 'sync', currentPoints: totalCredit });
                }
            } catch (e) {}
        }

        // 2. 🌟 状态追踪接口拦截（加入 /task/query 等全部官方查询接口）
        if (url.includes('/get_history_by_ids') || url.includes('/task/query') || url.includes('/infinite_canvas/fetch_conversation') || url.includes('/video/query') || url.includes('/image/query')) {
            try {
                const resBody = await safeCommand('Network.getResponseBody', { requestId });
                if (resBody && resBody.body) {
                    let bodyText = resBody.base64Encoded ? Buffer.from(resBody.body, 'base64').toString('utf-8') : resBody.body;
                    const data = JSON.parse(bodyText);

                    const finishedIds = new Set();
                    function scanForFinished(obj) {
                        if (!obj || typeof obj !== 'object') return;
                        for (const key in obj) {
                            const item = obj[key];
                            if (item && typeof item === 'object') {
                                const sid = item.submit_id || item.task_id || item.id || key;
                                const isFinished = (
                                    item.status_code === 50 || item.statusCode === 50 ||
                                    item.task_status === 'finished' || item.taskStatus === 'finished' ||
                                    item.status === 50 || item.status === 'completed' ||
                                    item.status === 'finished_successfully'
                                );
                                if (isFinished && typeof sid === 'string' && sid.includes('-')) {
                                    finishedIds.add(sid);
                                }
                                scanForFinished(item);
                            }
                        }
                    }
                    scanForFinished(data);

                    finishedIds.forEach(sid => {
                        onPointsUpdate({ type: 'standard_task_finished', submit_id: sid });
                    });
                }
            } catch (e) {}
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
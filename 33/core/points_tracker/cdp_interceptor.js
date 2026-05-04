/**
 * cdp_interceptor.js - 即梦AI网页版 CDP 网络拦截器
 */
const Heartbeat = require('./heartbeat');

function parseGenerateRequest(postDataStr, submitId) {
    let taskInfo = {
        submit_id: submitId,
        billingId: 'auto_catch',
        taskType: 'image',
        taskTypeName: '生成任务',
        resolution: '-',
        duration: 0,
        prompt: '智能体或快捷模式',
        timestamp: Date.now(),
        billed: false,
        real_cost: 0,
        localCost: 5,
        isAlien: false
    };

    try {
        const body = JSON.parse(postDataStr);

        // 针对 Agent 流式请求的 Prompt 解析增强
        if (body.content) {
            taskInfo.prompt = body.content;
            taskInfo.taskTypeName = 'Agent 生成';
        }
        if (!taskInfo.prompt && Array.isArray(body.messages)) {
            const userMsg = [...body.messages].reverse().find(m => m.role === 'user');
            if (userMsg && userMsg.content) {
                taskInfo.prompt = userMsg.content;
                taskInfo.taskTypeName = 'Agent 生成';
            }
        }

        try {
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
            if (typeLower === 'video' || draftLower.includes('gen_video')) {
                taskInfo.taskType = 'video';
                taskInfo.taskTypeName = '视频生成';
            } else if (typeLower.includes('audio') || typeLower.includes('tts') || draftLower.includes('audio') || draftLower.includes('tts')) {
                taskInfo.taskType = 'audio';
                taskInfo.taskTypeName = '音频配音';
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

        } catch (e) {
            console.warn('[CDP] 扩展信息解析失败，使用保底数据');
        }
    } catch (e) {}

    return taskInfo;
}

function setupCdpInterceptor(win, onPointsUpdate) {
    const logger = {
        info: (...a) => console.log('[CDP Interceptor]', new Date().toLocaleTimeString('zh-CN', { hour12: false }), ...a),
        warn: (...a) => console.warn('[CDP Interceptor]', ...a),
        error: (...a) => console.error('[CDP Interceptor]', ...a),
    };

    const rentTaskPool = new Map();
    const completedTaskSet = new Set();

    // 【核心新增】：暂存发出的请求体，用来给流式任务拼接参数
    const requestMap = new Map(); // requestId -> { method, url, postData, timestamp }

    // 【终极武器 1】：已处理历史记录的唯一 ID 黑名单集合
    const seenHistoryIds = new Set();

    let isInitialized = false;
    let attached = false;
    let enabled = false;

    const heartbeat = new Heartbeat(win);
    onPointsUpdate({ type: 'init', winId: win.id });

    async function safeCommand(cmd, params = {}) {
        if (!attached || !enabled || win.isDestroyed()) return null;
        try { return await win.webContents.debugger.sendCommand(cmd, params); } catch (e) { return null; }
    }

    async function handleRequestWillBeSent(params) {
        let postDataStr = params.request.postData || '';

        if (params.request.method === 'POST') {
            if (!postDataStr && params.request.hasPostData) {
                try {
                    const res = await safeCommand('Network.getRequestPostData', { requestId: params.requestId });
                    if (res && res.postData) postDataStr = res.postData;
                } catch (e) {}
            }

            // 暂存请求，供流式拦截使用
            requestMap.set(params.requestId, {
                method: params.request.method,
                url: params.request.url,
                postData: postDataStr,
                timestamp: Date.now()
            });

            if (!postDataStr) return;

            if (params.request.url.includes('/commerce/v1/benefits/user_credit_history')) {
                heartbeat.updateTemplate(params.request.url, postDataStr, params.request.headers);
            }

            const submitRegex = /"submit_id"\s*:\s*"([^"]+)"/g;
            let match;
            while ((match = submitRegex.exec(postDataStr)) !== null) {
                const submitId = match[1];
                if (!rentTaskPool.has(submitId)) {
                    const parsed = parseGenerateRequest(postDataStr, submitId);
                    rentTaskPool.set(submitId, parsed);
                    logger.info(`📝 [Request嗅探] 录入本地任务, submit_id=${submitId}`);
                }
            }
        }
    }

    // 【新增】：专门对付 SSE 流式 Agent 任务
    function handleEventSourceMessage(params) {
        const data = params.data || '';
        if (data.includes('"submit_id"')) {
            const submitRegex = /"submit_id"\s*:\s*"([^"]+)"/g;
            let match;
            while ((match = submitRegex.exec(data)) !== null) {
                const submitId = match[1];
                if (!rentTaskPool.has(submitId)) {
                    const req = requestMap.get(params.requestId) || { postData: '' };
                    const parsed = parseGenerateRequest(req.postData, submitId);
                    parsed.taskTypeName = 'Agent 流式生成';
                    rentTaskPool.set(submitId, parsed);
                    logger.info(`🌊 [SSE流式嗅探] 截获Agent任务, submit_id=${submitId}`);
                }
            }
        }
    }

    // 【新增】：兜底 WebSocket
    function handleWebSocketFrame(params) {
        const payload = params.response?.payloadData || '';
        if (typeof payload === 'string' && payload.includes('"submit_id"')) {
            const submitRegex = /"submit_id"\s*:\s*"([^"]+)"/g;
            let match;
            while ((match = submitRegex.exec(payload)) !== null) {
                const submitId = match[1];
                if (!rentTaskPool.has(submitId)) {
                    const parsed = parseGenerateRequest(payload, submitId);
                    parsed.taskTypeName = 'Agent WS生成';
                    rentTaskPool.set(submitId, parsed);
                    logger.info(`🔌 [WS嗅探] 截获任务, submit_id=${submitId}`);
                }
            }
        }
    }

    async function handleResponseReceived(params) {
        const url = params.response.url;
        const requestId = params.requestId;
        const reqInfo = requestMap.get(requestId);
        const method = reqInfo ? reqInfo.method : '';

        // 【吸收精髓：兼容 Agent 流式响应，突破 MIME 限制】
        const allowedResponseUrls = ['/generate', '/send', '/bot/chat', '/agent/', '/conversation', '/chat/completions'];
        const isAllowedResponseUrl = allowedResponseUrls.some(keyword => url.includes(keyword));
        const isAgentUrl = url.includes('/agent/');

        if (method === 'POST' && isAllowedResponseUrl && (isAgentUrl || params.response.mimeType?.includes('application/json'))) {
            try {
                const resBody = await safeCommand('Network.getResponseBody', { requestId });
                if (resBody && resBody.body && resBody.body.includes('"submit_id"')) {
                    const submitRegex = /"submit_id"\s*:\s*"([^"]+)"/g;
                    let match;
                    while ((match = submitRegex.exec(resBody.body)) !== null) {
                        const submitId = match[1];
                        if (!rentTaskPool.has(submitId)) {
                            const parsed = parseGenerateRequest(resBody.body, submitId);
                            parsed.taskTypeName = parsed.taskTypeName || 'Agent 生成';
                            rentTaskPool.set(submitId, parsed);
                            logger.info(`🔍 [Response嗅探] 截获新生任务, submit_id=${submitId}`);
                        }
                    }
                }
            } catch (e) {}
        }

        if (url.includes('/commerce/v1/benefits/user_credit_history')) {
            const responseBody = await safeCommand('Network.getResponseBody', { requestId });
            if (!responseBody) return;

            try {
                const body = JSON.parse(responseBody.body);
                const records = body.data?.records || [];
                const totalCredit = body.data?.total_credit || 0;

                if (!isInitialized) {
                    isInitialized = true;
                    onPointsUpdate({ type: 'sync', currentPoints: totalCredit });
                    for (const r of records) seenHistoryIds.add(r.history_id);
                    return;
                } else {
                    onPointsUpdate({ type: 'sync', currentPoints: totalCredit });
                }

                const sortedRecords = [...records].reverse();

                for (const record of sortedRecords) {
                    if (seenHistoryIds.has(record.history_id)) continue;
                    seenHistoryIds.add(record.history_id);

                    const submitId = record.submit_id;
                    let taskInfo = rentTaskPool.get(submitId);

                    if (!taskInfo) {
                        taskInfo = {
                            submit_id: submitId,
                            billingId: 'alien_task',
                            taskType: record.title?.includes('视频') ? 'video' : (record.title?.includes('音频') ? 'audio' : 'image'),
                            taskTypeName: record.title || '生成任务',
                            resolution: '-',
                            duration: 0,
                            prompt: '其他设备或窗口的操作',
                            timestamp: Date.now(),
                            billed: true,
                            real_cost: 0,
                            localCost: record.amount || 0,
                            isAlien: true
                        };
                        rentTaskPool.set(submitId, taskInfo);
                    }

                    // 【核心修复：绝对不提前删除 submitId！让同一 ID 的多次扣费如实展示】
                    if (record.history_type === 2) {
                        taskInfo.billed = true;
                        onPointsUpdate({
                            type: 'cost',
                            deduct: record.amount,
                            localCost: taskInfo.localCost,
                            billingId: taskInfo.billingId,
                            taskType: taskInfo.taskType,
                            taskTypeName: taskInfo.taskTypeName,
                            resolution: taskInfo.resolution,
                            duration: taskInfo.duration,
                            prompt: taskInfo.prompt,
                            timestamp: taskInfo.timestamp, // 将时间戳传给前端
                            isAlien: taskInfo.isAlien
                        });
                    }
                    else if (record.history_type === 1) {
                        onPointsUpdate({
                            type: 'refund',
                            refund: record.amount,
                            billingId: taskInfo.billingId,
                            taskType: taskInfo.taskType,
                            taskTypeName: taskInfo.taskTypeName,
                            isAlien: taskInfo.isAlien
                        });
                    }
                    // 注释掉原有的 rentTaskPool.delete(submitId)，让60小时兜底去清理，保证一号多单完美扣费
                }

                const now = Date.now();
                for (const [submitId, task] of rentTaskPool) {
                    if (now - task.timestamp > 216000000) rentTaskPool.delete(submitId);
                }
                for (const [reqId, req] of requestMap) {
                    if (now - req.timestamp > 300000) requestMap.delete(reqId); // 清理 5 分钟前的请求体缓存
                }

            } catch (e) {
                logger.warn('积分历史响应解析失败:', e.message);
            }
        }
    }

    function onDebuggerMessage(event, method, params) {
        if (method === 'Network.requestWillBeSent') handleRequestWillBeSent(params);
        else if (method === 'Network.responseReceived') handleResponseReceived(params);
        // 新增流式及 WebSocket 监听
        else if (method === 'Network.eventSourceMessageReceived') handleEventSourceMessage(params);
        else if (method === 'Network.webSocketFrameReceived') handleWebSocketFrame(params);
    }

    try {
        win.webContents.debugger.attach('1.3');
        attached = true;
    } catch (err) {
        return { detach: () => {} };
    }

    win.webContents.debugger.on('message', onDebuggerMessage);
    win.webContents.debugger.sendCommand('Network.enable').then(() => enabled = true);

    function detach() {
        if (!attached) return;
        try {
            win.webContents.debugger.off('message', onDebuggerMessage);
            win.webContents.debugger.detach();
        } catch (e) {}

        heartbeat.destroy();

        rentTaskPool.clear();
        completedTaskSet.clear();
        seenHistoryIds.clear();
        requestMap.clear();
        isInitialized = false;
        attached = false;
        enabled = false;
        logger.info('专属 CDP 拦截器已销毁');
    }

    return { detach };
}

module.exports = { setupCdpInterceptor };

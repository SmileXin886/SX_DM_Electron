/**
 * cdp_interceptor.js - 即梦AI网页版 CDP 网络拦截器 (无限画布精准关联+防时序错位版)
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
        prompt: '快捷生成模式',
        timestamp: Date.now(),
        billed: false,
        real_cost: 0,
        localCost: 5,
        isAlien: false
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
            taskInfo.taskType = 'video';
            taskInfo.taskTypeName = '视频生成';
        } else if (typeLower.includes('audio') || typeLower.includes('tts') || draftLower.includes('audio') || draftLower.includes('tts')) {
            taskInfo.taskType = 'audio';
            taskInfo.taskTypeName = '音频配音';
        } else {
            taskInfo.taskType = 'image';
            taskInfo.taskTypeName = '图片生成';
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

// 暴力穿透提取 36 位 ID，无视各种斜杠和转义
function extractSubmitIdsFromText(data) {
    const results = new Set();
    const regex = /submit_id[^\w-]+([a-f0-9-]{36})/gi;
    let m;
    while ((m = regex.exec(data)) !== null) results.add(m[1]);
    return Array.from(results);
}

function setupCdpInterceptor(win, onPointsUpdate) {
    const logger = {
        info: (...a) => console.log('🔵 [CDP 追踪]', new Date().toLocaleTimeString('zh-CN', { hour12: false }), ...a),
        warn: (...a) => console.warn('🟠 [CDP 认证]', new Date().toLocaleTimeString('zh-CN', { hour12: false }), ...a),
        error: (...a) => console.error('🔴 [CDP 错误]', new Date().toLocaleTimeString('zh-CN', { hour12: false }), ...a),
    };

    const rentTaskPool = new Map();     
    const requestMap = new Map();       
    const pendingByUserMsg = new Map(); 
    let localDataMapCache = new Map();

    // 恢复账单等待室（解决时序错位问题）
    const suspendedDeductions = new Map(); 

    const seenHistoryIds = new Set();      
    let isFirstCreditLoad = true;
    const sessionStartTimeSec = Date.now() / 1000;

    let attached = false;
    let enabled = false;

    const heartbeat = new Heartbeat(win);
    onPointsUpdate({ type: 'init', winId: win.id });

    async function safeCommand(cmd, params = {}) {
        if (!attached || !enabled || win.isDestroyed()) return null;
        try { return await win.webContents.debugger.sendCommand(cmd, params); } catch (e) { return null; }
    }

    async function syncLocalStorageMapping() {
        try {
            const res = await safeCommand('Runtime.evaluate', {
                expression: `(function(){
                    try {
                        const snapshots = localStorage.getItem('dreamina__aigc-data-debug-snapshots');
                        if(!snapshots) return '{}';
                        const parsed = JSON.parse(snapshots);
                        const map = {};
                        for(const umId in parsed) {
                            map[umId] = [];
                            const snaps = parsed[umId].snapshots || [];
                            for(const snap of snaps) {
                                if(snap.model && snap.model.submitIdDataMap) {
                                    Object.keys(snap.model.submitIdDataMap).forEach(k => {
                                        if(!map[umId].includes(k)) map[umId].push(k);
                                    });
                                }
                                if(snap.model && snap.model.submitId && !map[umId].includes(snap.model.submitId)) {
                                    map[umId].push(snap.model.submitId);
                                }
                            }
                        }
                        return JSON.stringify(map);
                    } catch(e) { return '{}'; }
                })()`,
                returnByValue: true
            });
            if (res && res.result && res.result.value) {
                const parsedMap = JSON.parse(res.result.value);
                for (const [umId, childIds] of Object.entries(parsedMap)) {
                    localDataMapCache.set(umId, childIds);
                }
            }
        } catch (e) {}
    }

    function executeFinalDeduction(submitId, record) {
        const taskInfo = rentTaskPool.get(submitId);
        if (!taskInfo || taskInfo.billed) return; 

        taskInfo.billed = true;
        taskInfo.real_cost = record.amount;

        onPointsUpdate({
            type: 'cost',
            deduct: record.amount,
            localCost: taskInfo.localCost || record.amount,
            billingId: taskInfo.billingId,
            taskType: taskInfo.taskType,
            taskTypeName: taskInfo.taskTypeName,
            resolution: taskInfo.resolution,
            duration: taskInfo.duration,
            prompt: taskInfo.prompt,
            timestamp: taskInfo.timestamp,
            isAlien: taskInfo.isAlien,
            userMessageId: taskInfo.userMessageId,
            submit_id: submitId
        });
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
        let reqInfo = { method: params.request.method, url: params.request.url, timestamp: Date.now() };

        if (urlLower.includes('/commerce/v1/benefits/user_credit_history')) {
            heartbeat.updateTemplate(params.request.url, postDataStr, params.request.headers);
        }

        let agentMode = '';
        if (urlLower.includes('/infinite_canvas/conversation')) agentMode = '无限画布 Agent';
        else if (urlLower.includes('/creation_agent/v2/conversation')) agentMode = '标准 Agent';

        if (agentMode) {
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
                        if (body.messages[0].content?.content_parts?.[0]?.text) promptText = body.messages[0].content.content_parts[0].text;
                    } catch (e) {}
                }
            } catch (e) {}

            if (!umId) {
                const strictUmMatch = postDataStr.match(/"userMessageId"\\?\s*:\s*\\?"([0-9a-fA-F-]{36})\\?"/i);
                if (strictUmMatch) umId = strictUmMatch[1];
            }

            if (umId) {
                reqInfo.userMessageId = umId;
                reqInfo.prompt = promptText;
                reqInfo.agentMode = agentMode;
                // 登记入池，作为账单等待判断的依据
                pendingByUserMsg.set(umId, { timestamp: Date.now(), prompt: promptText, mode: agentMode });
                
                logger.info(`【任务识别】-> 模式: ${agentMode} | 绑定消息ID: ${umId} | 截断内容: ${promptText.slice(0,20)}`);
            }
        }
        requestMap.set(params.requestId, reqInfo);

        const isCancel = urlLower.includes('cancel') || urlLower.includes('delete') || urlLower.includes('stop') || postDataStr.includes('"action":"cancel"');
        const submitRegex = /"submit_id"\s*:\s*"([^"]+)"/g;
        let match;
        while ((match = submitRegex.exec(postDataStr)) !== null) {
            const submitId = match[1];
            if (isCancel) {
                if (!rentTaskPool.has(submitId)) {
                    const parsed = parseGenerateRequest(postDataStr, submitId);
                    parsed.taskTypeName = '积分返还'; parsed.taskType = 'refund'; parsed.prompt = '主动取消任务';
                    rentTaskPool.set(submitId, parsed);
                } else rentTaskPool.get(submitId).taskTypeName = '积分返还 (已取消)';
            } else if (!rentTaskPool.has(submitId)) {
                const parsed = parseGenerateRequest(postDataStr, submitId);
                if (postDataStr.includes('creation_agent') && !parsed.taskTypeName.startsWith('Agent')) parsed.taskTypeName = '标准 Agent';
                parsed.isAlien = false; 
                rentTaskPool.set(submitId, parsed);
            }
        }
    }

    async function handleLoadingFinished(params) {
        const reqInfo = requestMap.get(params.requestId);
        if (!reqInfo || !reqInfo.userMessageId) return; 

        const agentMode = reqInfo.agentMode || '未知模式';
        const umId = reqInfo.userMessageId;

        try {
            // CDP 获取流结束后的完整响应体
            const resBody = await safeCommand('Network.getResponseBody', { requestId: params.requestId });
            if (resBody && resBody.body) {
                let bodyText = resBody.body;
                // 防御 Base64 编码导致正则匹配失败的盲区
                if (resBody.base64Encoded) {
                    bodyText = Buffer.from(resBody.body, 'base64').toString('utf-8');
                }

                // 暴力提取流中所有的 submit_id
                const submitIds = extractSubmitIdsFromText(bodyText);
                
                for (const submitId of submitIds) {
                    if (!rentTaskPool.has(submitId)) {
                        rentTaskPool.set(submitId, {
                            submit_id: submitId, billingId: 'auto_catch', taskType: 'image', 
                            taskTypeName: agentMode, prompt: reqInfo.prompt || 'Agent 智能体生成',
                            timestamp: Date.now(), billed: false, localCost: 5, isAlien: false, userMessageId: umId 
                        });
                    } else {
                        let task = rentTaskPool.get(submitId);
                        task.isAlien = false; 
                        task.userMessageId = umId;
                        task.taskTypeName = agentMode; 
                    }
                    
                    // 🌟 重点：如果账单因为时序错位提前到了且被挂起，现在铁证已拿到，立刻释放结算！
                    if (suspendedDeductions.has(submitId)) {
                        const suspended = suspendedDeductions.get(submitId);
                        clearTimeout(suspended.timer);
                        logger.info(`[流解析出证] 🟢 铁证如山！确认账单 [${submitId}] 归属本机发起的消息 [${umId}]。立即核销结算！`);
                        executeFinalDeduction(submitId, suspended.record);
                        suspendedDeductions.delete(submitId);
                    }
                }
            }
        } catch(e) {}
    }

    function handleEventSourceMessage(params) {
        const { requestId, data } = params;
        if (!data || !data.includes('submit_id')) return;
        
        const reqInfo = requestMap.get(requestId);
        if (!reqInfo || !reqInfo.userMessageId) return; 

        const umId = reqInfo.userMessageId;
        const agentMode = reqInfo.agentMode || '标准 Agent';

        const submitIds = extractSubmitIdsFromText(data);

        for (const submitId of submitIds) {
            if (!rentTaskPool.has(submitId)) {
                rentTaskPool.set(submitId, {
                    submit_id: submitId, billingId: 'auto_catch', taskType: 'image', 
                    taskTypeName: agentMode, prompt: reqInfo.prompt || 'Agent 智能体生成',
                    timestamp: Date.now(), billed: false, localCost: 5, isAlien: false, userMessageId: umId 
                });
            } else {
                let task = rentTaskPool.get(submitId);
                task.isAlien = false;
                task.userMessageId = umId;
                task.taskTypeName = agentMode; 
            }

            // 如果 CDP 正常触发了 SSE 事件，也执行释放
            if (suspendedDeductions.has(submitId)) {
                const suspended = suspendedDeductions.get(submitId);
                clearTimeout(suspended.timer);
                logger.info(`[流解析出证] 🟢 铁证如山！确认账单 [${submitId}] 归属本机。立即核销结算！`);
                executeFinalDeduction(submitId, suspended.record);
                suspendedDeductions.delete(submitId);
            }
        }
    }

    async function handleResponseReceived(params) {
        const url = params.response.url;
        const requestId = params.requestId;

        if (url.includes('/mweb/v1/get_history_by_ids')) {
            try {
                await syncLocalStorageMapping();
                const resBody = await safeCommand('Network.getResponseBody', { requestId });
                if (!resBody || !resBody.body) return;
                
                const data = JSON.parse(resBody.body);
                if (!data || !data.data) return;

                for (const [rawKey, task] of Object.entries(data.data)) {
                    if (!rawKey || rawKey === 'undefined') continue;
                    const realSubmitId = task.submit_id || task.capflow_id || rawKey;

                    let umId = null;

                    if (task.metrics_extra) {
                        try {
                            const extra = typeof task.metrics_extra === 'string' ? JSON.parse(task.metrics_extra) : task.metrics_extra;
                            if (extra.userMessageId) umId = extra.userMessageId; 
                        } catch (e) {}
                    }
                    if (!umId) {
                        const taskString = JSON.stringify(task);
                        for (const pendingUmId of pendingByUserMsg.keys()) {
                            if (taskString.includes(pendingUmId)) { umId = pendingUmId; break; }
                        }
                    }
                    if (!umId) {
                        for (const [parentUmId, childIds] of localDataMapCache.entries()) {
                            if (childIds.includes(realSubmitId) || parentUmId === realSubmitId) { umId = parentUmId; break; }
                        }
                    }

                    const isOurAgentTask = umId && pendingByUserMsg.has(umId);
                    
                    const draftContentStr = task.draft_content || '';
                    const mode = task.mode || '';
                    const isAgent = mode.includes('creation_agent') || draftContentStr.includes('creation_agent');
                    const modelKey = String(task.model_info?.model_req_key || '').toLowerCase();
                    let taskTypeClass = 'image';
                    if (task.generate_type === 2 || modelKey.includes('video') || modelKey.includes('seedance') || draftContentStr.includes('gen_video')) taskTypeClass = 'video';
                    else if (task.generate_type === 3 || modelKey.includes('audio') || modelKey.includes('tts')) taskTypeClass = 'audio';

                    let typeName = taskTypeClass === 'video' ? '视频生成' : (taskTypeClass === 'audio' ? '音频配音' : '图片生成');
                    
                    if (isAgent) {
                        if (isOurAgentTask && pendingByUserMsg.has(umId)) {
                            typeName = pendingByUserMsg.get(umId).mode;
                        } else {
                            typeName = mode.includes('infinite') ? '无限画布 Agent' : '标准 Agent';
                        }
                    }

                    let extractedPrompt = task.history_group_key || '智能体生成任务';
                    if (draftContentStr) {
                        try {
                            const comp = JSON.parse(draftContentStr).component_list?.[0];
                            extractedPrompt = comp?.abilities?.generate?.core_param?.prompt || comp?.abilities?.gen_video?.text_to_video_params?.video_gen_inputs?.[0]?.prompt || extractedPrompt;
                        } catch (e) {}
                    }

                    if (rentTaskPool.has(realSubmitId)) {
                        let existingTask = rentTaskPool.get(realSubmitId);
                        existingTask.taskType = taskTypeClass;
                        existingTask.taskTypeName = typeName;
                        existingTask.prompt = String(extractedPrompt).slice(0, 30);
                        if (isOurAgentTask) {
                            existingTask.isAlien = false;
                            existingTask.userMessageId = umId;
                        }
                    } else {
                        // 此处不做盲猜处理，只正常入池
                        rentTaskPool.set(realSubmitId, {
                            submit_id: realSubmitId, billingId: task.model_info?.model_req_key || 'auto_catch', taskType: taskTypeClass, taskTypeName: typeName,
                            prompt: String(extractedPrompt).slice(0, 30), timestamp: task.created_time ? task.created_time * 1000 : Date.now(), billed: false,
                            localCost: task.forecast_generate_cost || 5, 
                            isAlien: isOurAgentTask ? false : true, 
                            userMessageId: umId
                        });
                    }

                    if (isOurAgentTask && suspendedDeductions.has(realSubmitId)) {
                        const suspended = suspendedDeductions.get(realSubmitId);
                        clearTimeout(suspended.timer);
                        logger.info(`[账单释放] 🟢 历史API查出铁证！确认任务 [${realSubmitId}] 属本机，准许核销结算！`);
                        executeFinalDeduction(realSubmitId, suspended.record);
                        suspendedDeductions.delete(realSubmitId);
                    }
                }
            } catch (e) {}
        }

        // 历史账单到达
        if (url.includes('/commerce/v1/benefits/user_credit_history')) {
            const responseBody = await safeCommand('Network.getResponseBody', { requestId });
            if (!responseBody) return;

            try {
                await syncLocalStorageMapping();
                const body = JSON.parse(responseBody.body);
                const records = body.data?.records || [];
                const totalCredit = body.data?.total_credit || 0;
                onPointsUpdate({ type: 'sync', currentPoints: totalCredit });

                if (isFirstCreditLoad) {
                    for (const r of records) seenHistoryIds.add(r.history_id);
                    isFirstCreditLoad = false;
                    return;
                }

                const sortedRecords = [...records].reverse();

                for (const record of sortedRecords) {
                    if (seenHistoryIds.has(record.history_id)) continue;
                    const recordTime = record.create_time || 0;
                    if (recordTime > 0 && recordTime < sessionStartTimeSec) {
                        seenHistoryIds.add(record.history_id); continue;
                    }
                    seenHistoryIds.add(record.history_id);

                    const submitId = record.submit_id;
                    let taskInfo = rentTaskPool.get(submitId);

                    if (record.history_type === 1) {
                        onPointsUpdate({
                            type: 'refund', refund: record.amount,
                            billingId: taskInfo?.billingId || 'auto_catch', taskType: taskInfo?.taskType || 'image',
                            taskTypeName: taskInfo?.taskTypeName || '退款任务', isAlien: taskInfo ? (taskInfo.isAlien === false ? false : true) : false
                        });
                        continue;
                    }

                    if (!taskInfo) {
                        // 🌟 核心防误判逻辑：账单先到，但未在池子里找到 submit_id。检查本机是否发起了任务
                        let hasPendingInfiniteCanvas = false;
                        for (const meta of pendingByUserMsg.values()) {
                            if (meta.mode === '无限画布 Agent') { hasPendingInfiniteCanvas = true; break; }
                        }

                        taskInfo = {
                            submit_id: submitId, billingId: 'alien_task', taskType: record.title?.includes('视频') ? 'video' : 'image',
                            taskTypeName: record.title || '他人生成任务', prompt: '画布中其他人的操作',
                            timestamp: Date.now(), billed: false, real_cost: 0, localCost: record.amount || 0,
                            isAlien: hasPendingInfiniteCanvas ? 'pending' : true 
                        };
                        rentTaskPool.set(submitId, taskInfo);
                    }

                    if (taskInfo.isAlien === false) {
                        // 身份早已确认，直接结算
                        if (!taskInfo.billed) executeFinalDeduction(submitId, record);
                    } 
                    else if (taskInfo.isAlien === true) {
                        // 本机根本没有发起任务，确认为外人，秒推
                        logger.warn(`  ┣ 🔴 查无对证，确认为他人任务 (Alien)，直接秒级推送外人列表！`);
                        executeFinalDeduction(submitId, record);
                    } 
                    else if (taskInfo.isAlien === 'pending') {
                        // 本机有任务，账单提前到达。进入“等待室”，挂起死等流解析出凭证
                        if (!suspendedDeductions.has(submitId)) {
                            logger.warn(`  ┣ ⏳ [账单时序倒挂] 发现提前到账的扣费！由于本机有【无限画布】正在生成，将其挂起至账单等待室。等流出证...`);
                            
                            const timer = setTimeout(() => {
                                if (suspendedDeductions.has(submitId)) {
                                    logger.error(`[挂起超时] 🔴 任务 [${submitId}] 等待 120 秒后流解析依然未交出匹配ID。死刑：判定为他人任务！`);
                                    let t = rentTaskPool.get(submitId);
                                    if (t) t.isAlien = true;
                                    executeFinalDeduction(submitId, record);
                                    suspendedDeductions.delete(submitId);
                                }
                            }, 120000);

                            suspendedDeductions.set(submitId, { record, timer });
                        }
                    }
                }

                // 内存清理
                const now = Date.now();
                for (const [umId, meta] of pendingByUserMsg) {
                    if (now - meta.timestamp > 300000) pendingByUserMsg.delete(umId);
                }
                for (const [sId, task] of rentTaskPool) {
                    if (now - task.timestamp > 216000000) rentTaskPool.delete(sId);
                }
                for (const [reqId, req] of requestMap) {
                    if (now - req.timestamp > 300000) requestMap.delete(reqId);
                }
            } catch (e) {
                logger.error('积分历史解析失败:', e.message);
            }
        }
    }

    function onDebuggerMessage(event, method, params) {
        if (method === 'Network.requestWillBeSent') handleRequestWillBeSent(params);
        else if (method === 'Network.responseReceived') handleResponseReceived(params);
        else if (method === 'Network.eventSourceMessageReceived') handleEventSourceMessage(params);
        else if (method === 'Network.loadingFinished') handleLoadingFinished(params);
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
        seenHistoryIds.clear();
        requestMap.clear();
        pendingByUserMsg.clear();
        localDataMapCache.clear();
        suspendedDeductions.clear();
        isFirstCreditLoad = true;
        attached = false;
        enabled = false;
        logger.info('专属 CDP 拦截器已销毁');
    }

    return { detach };
}

module.exports = { setupCdpInterceptor };
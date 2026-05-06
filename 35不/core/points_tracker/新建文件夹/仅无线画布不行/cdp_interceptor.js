/**
 * cdp_interceptor.js - 即梦AI网页版 CDP 网络拦截器 (全通道审判+UI修复版)
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

function extractSubmitIdsFromSse(data) {
    const results = new Set();
    const regexEscaped = /\\"submit_id\\"\s*:\s*\\"([a-f0-9-]{8,})\\"/g;
    let m;
    while ((m = regexEscaped.exec(data)) !== null) results.add(m[1]);
    const regexNormal = /"submit_id"\s*:\s*"([a-f0-9-]{8,})"/g;
    while ((m = regexNormal.exec(data)) !== null) results.add(m[1]);
    return Array.from(results);
}

function setupCdpInterceptor(win, onPointsUpdate) {
    const logger = {
        info: (...a) => console.log('🔵 [CDP 追踪]', new Date().toLocaleTimeString('zh-CN', { hour12: false }), ...a),
        warn: (...a) => console.warn('🟠 [CDP 审判]', new Date().toLocaleTimeString('zh-CN', { hour12: false }), ...a),
        error: (...a) => console.error('🔴 [CDP 错误]', ...a),
    };

    const rentTaskPool = new Map();     
    const requestMap = new Map();       
    const pendingByUserMsg = new Map(); 
    let localDataMapCache = new Map();  // 存储从 LocalStorage 偷出来的映射关系

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

    // 🌟 黑科技：跨界读取前端 LocalStorage，破解子任务关联！
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
                            const snaps = parsed[umId].snapshots;
                            if(!snaps || snaps.length === 0) continue;
                            const lastSnap = snaps[snaps.length - 1];
                            const dataMap = lastSnap.model.submitIdDataMap;
                            if(dataMap) {
                                map[umId] = Object.keys(dataMap);
                            } else {
                                map[umId] = [];
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

    // ==========================================
    // 阶段1：发起请求
    // ==========================================
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

        let reqInfo = {
            method: params.request.method,
            url: params.request.url,
            postData: postDataStr,
            timestamp: Date.now(),
            userMessageId: null,
            conversationId: null
        };

        if (urlLower.includes('/commerce/v1/benefits/user_credit_history')) {
            heartbeat.updateTemplate(params.request.url, postDataStr, params.request.headers);
        }

        // 🎯 抓取 userMessageId
        if (!urlLower.includes('get_history_by_ids') && !urlLower.includes('user_credit_history')) {
            let umId = null;
            let convId = null;
            let promptText = 'Agent 智能体生成';

            try {
                const body = JSON.parse(postDataStr);
                convId = body.conversation_id || body.extend?.conversation_id;

                if (body.messages && Array.isArray(body.messages) && body.messages.length > 0) {
                    umId = body.messages[0].id;
                    if (!umId && body.messages[0].metadata?.metrics_extra) {
                        let extra = body.messages[0].metadata.metrics_extra;
                        if (typeof extra === 'string') extra = JSON.parse(extra);
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

            if (umId) {
                reqInfo.userMessageId = umId;
                reqInfo.conversationId = convId;
                
                pendingByUserMsg.set(umId, { 
                    conversationId: convId,
                    submitIds: [],
                    timestamp: Date.now() 
                });

                // 防御性编程：主 ID 本身也有可能被当作 submit_id 计费
                rentTaskPool.set(umId, {
                    submit_id: umId,
                    taskType: 'image',
                    taskTypeName: 'Agent 主任务',
                    prompt: promptText.slice(0, 30),
                    timestamp: Date.now(),
                    billed: false,
                    isAlien: false,
                    userMessageId: umId
                });
                
                logger.info(`[Step 1 - 请求拦截] 🎯 锁定本窗口任务! ID: ${umId} | 内容: ${promptText.slice(0,20)}`);
            }
        }
        requestMap.set(params.requestId, reqInfo);
    }

    // ==========================================
    // 阶段2：SSE 流拦截 
    // ==========================================
    function handleEventSourceMessage(params) {
        const { requestId, data } = params;
        if (!data || !data.includes('submit_id')) return;

        const submitIds = extractSubmitIdsFromSse(data);
        if (submitIds.length === 0) return;

        const reqInfo = requestMap.get(requestId);
        let umId = reqInfo ? reqInfo.userMessageId : null;

        if (!umId && pendingByUserMsg.size > 0) {
            umId = Array.from(pendingByUserMsg.keys()).pop();
        }

        for (const submitId of submitIds) {
            if (submitId && !rentTaskPool.has(submitId)) {
                rentTaskPool.set(submitId, {
                    submit_id: submitId,
                    billingId: 'auto_catch', 
                    taskType: 'image', 
                    taskTypeName: 'Agent 生成',
                    prompt: 'Agent 智能体生成',
                    timestamp: Date.now(),
                    billed: false,
                    localCost: 5,
                    isAlien: umId ? false : true,
                    userMessageId: umId 
                });
                logger.info(`[Step 2 - SSE流] 🌊 成功捕捉 submit_id: ${submitId} -> 关联: ${umId || '无'}`);
            }
        }
    }

    // ==========================================
    // 阶段3 & 4：History 审判与积分结算
    // ==========================================
    async function handleResponseReceived(params) {
        const url = params.response.url;
        const requestId = params.requestId;

        // --- 阶段3：History 审判台 ---
        if (url.includes('/mweb/v1/get_history_by_ids')) {
            try {
                // 每次轮询前，先去 LocalStorage 偷看账本！
                await syncLocalStorageMapping();

                const resBody = await safeCommand('Network.getResponseBody', { requestId });
                if (!resBody || !resBody.body) return;
                
                const data = JSON.parse(resBody.body);
                if (!data || !data.data) return;

                for (const [rawKey, task] of Object.entries(data.data)) {
                    if (!rawKey || rawKey === 'undefined') continue;
                    const realSubmitId = task.submit_id || task.capflow_id || rawKey;

                    // 【核心审判逻辑全曝光】
                    logger.warn(`[Step 3 - 深度审判] ⚖️ 正在核验任务: ${realSubmitId}`);
                    
                    let umId = null;
                    let matchSource = '未找到';

                    // 1. 尝试从 metrics_extra 寻找 (常规模式)
                    if (task.metrics_extra) {
                        try {
                            const extra = typeof task.metrics_extra === 'string' ? JSON.parse(task.metrics_extra) : task.metrics_extra;
                            if (extra.userMessageId) {
                                umId = extra.userMessageId;
                                matchSource = '接口 metrics_extra';
                            }
                        } catch (e) {}
                    }

                    // 2. 尝试从 LocalStorage 账本寻找 (画布模式大杀器！)
                    if (!umId) {
                        for (const [parentUmId, childIds] of localDataMapCache.entries()) {
                            if (childIds.includes(realSubmitId) || parentUmId === realSubmitId) {
                                umId = parentUmId;
                                matchSource = '浏览器 LocalStorage 映射表';
                                break;
                            }
                        }
                    }

                    const isOurAgentTask = umId && pendingByUserMsg.has(umId);
                    
                    // 打印审判结论
                    if (isOurAgentTask) {
                        logger.info(`  ┣ 🟢 身份确认: 属于本窗口!`);
                        logger.info(`  ┣ 🔗 寻找证据: 通过 [${matchSource}] 追溯到主 ID: ${umId}`);
                    } else {
                        logger.warn(`  ┣ 🔴 身份否决: 判定为他人任务 (Alien)`);
                        logger.warn(`  ┗ 💔 失败原因: ${umId ? `找到了主 ID (${umId})，但不在本窗口的发起池中` : '所有渠道均未找到任何关联信息'}`);
                    }

                    const draftContentStr = task.draft_content || '';
                    const mode = task.mode || '';
                    const isAgent = mode.includes('creation_agent') || draftContentStr.includes('creation_agent');
                    const modelKey = String(task.model_info?.model_req_key || '').toLowerCase();
                    
                    let taskTypeClass = 'image';
                    if (task.generate_type === 2 || modelKey.includes('video') || modelKey.includes('seedance') || draftContentStr.includes('gen_video')) taskTypeClass = 'video';
                    else if (task.generate_type === 3 || modelKey.includes('audio') || modelKey.includes('tts')) taskTypeClass = 'audio';

                    let typeName = taskTypeClass === 'video' ? '视频生成' : (taskTypeClass === 'audio' ? '音频配音' : '图片生成');
                    if (isAgent) typeName = 'Agent ' + typeName;

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
                        rentTaskPool.set(realSubmitId, {
                            submit_id: realSubmitId,
                            billingId: task.model_info?.model_req_key || 'auto_catch',
                            taskType: taskTypeClass,
                            taskTypeName: typeName,
                            prompt: String(extractedPrompt).slice(0, 30),
                            timestamp: task.created_time ? task.created_time * 1000 : Date.now(),
                            billed: false,
                            localCost: task.forecast_generate_cost || 5,
                            isAlien: !isOurAgentTask,
                            userMessageId: umId
                        });
                    }
                }
            } catch (e) {}
        }

        // --- 阶段4：积分结算 (UI 修复版) ---
        if (url.includes('/commerce/v1/benefits/user_credit_history')) {
            const responseBody = await safeCommand('Network.getResponseBody', { requestId });
            if (!responseBody) return;

            try {
                // 再次拉取最新映射
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

                    logger.info(`\n[Step 4 - 积分结算触发] 💰 官方扣费来袭! submit_id: ${submitId}`);

                    // 最终防线：如果在扣费这一刻发现没有关联，最后查一次字典
                    if (taskInfo && taskInfo.isAlien) {
                        for (const [parentUmId, childIds] of localDataMapCache.entries()) {
                            if (childIds.includes(submitId) || parentUmId === submitId) {
                                if (pendingByUserMsg.has(parentUmId)) {
                                    logger.info(`  ┣ 🚑 临死前抢救成功！在结算瞬间通过 LocalStorage 洗白了任务！`);
                                    taskInfo.isAlien = false;
                                    taskInfo.userMessageId = parentUmId;
                                    break;
                                }
                            }
                        }
                    }

                    if (!taskInfo) {
                        logger.warn(`  ┗ 🚫 拒绝结算！本地池完全为空，判定为彻底的他人任务 (isAlien: true)`);
                        taskInfo = {
                            submit_id: submitId,
                            billingId: 'alien_task',
                            taskType: record.title?.includes('视频') ? 'video' : 'image',
                            taskTypeName: record.title || '他人生成任务',
                            prompt: '其他窗口产生的操作',
                            timestamp: Date.now(),
                            billed: true,
                            real_cost: record.amount,
                            isAlien: true
                        };
                        rentTaskPool.set(submitId, taskInfo);
                    } else if (taskInfo.isAlien) {
                        logger.warn(`  ┗ 🚫 拒绝结算！该任务已在 Step 3 审判中被定性为他人任务 (isAlien: true)`);
                    } else {
                        logger.info(`  ┗ ✅ 完美结算！属于我们的任务，予以扣费。(userMsgId: ${taskInfo.userMessageId})`);
                    }

                    if (record.history_type === 2) {
                        taskInfo.billed = true;
                        taskInfo.real_cost = record.amount;
                        
                        // 🌟 修复 UI 更新 BUG：无论是不是 Alien，都必须调用 onPointsUpdate，把 isAlien 传给前端！
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
                            isAlien: taskInfo.isAlien,      // <--- 前端就是靠这个区分是不是他人任务的！
                            userMessageId: taskInfo.userMessageId,
                            submit_id: submitId
                        });
                        
                    } else if (record.history_type === 1) {
                        // 🌟 同样修复返还 UI
                        onPointsUpdate({
                            type: 'refund',
                            refund: record.amount,
                            billingId: taskInfo.billingId,
                            taskType: taskInfo.taskType,
                            taskTypeName: taskInfo.taskTypeName,
                            isAlien: taskInfo.isAlien
                        });
                    }
                }

                // 清理过期数据
                const now = Date.now();
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
        isFirstCreditLoad = true;
        attached = false;
        enabled = false;
        logger.info('专属 CDP 拦截器已销毁');
    }

    return { detach };
}

module.exports = { setupCdpInterceptor };
/**
 * cdp_interceptor.js - 即梦AI网页版 CDP 网络拦截器
 *
 * 核心设计（"即时扣费，失败返还"模式）：
 * - rentTaskPool（Map）：本地专属任务池，按 submit_id 索引
 * - completedTaskSet（Set）：已完成计费的任务 ID，避免分页重复统计
 * - billed 字段：标记是否已触发即时扣费，防止重复
 * - real_cost 字段：记录真实扣量，用于失败时精确返还
 * - 计费逻辑完全收口在 Network.responseReceived 中，通过 submit_id 精确匹配
 */

/**
 * 全局任务池：submit_id → 任务信息
 * @type {Map<string, {submit_id: string, benefit_type: string, resolution: string, duration: number, prompt: string, taskType: string, timestamp: number, billed: boolean, real_cost: number}>}
 */
const rentTaskPool = new Map();

/**
 * 已完成计费的任务 ID 集合，避免分页数据重复统计
 * @type {Set<string>}
 */
const completedTaskSet = new Set();

/**
 * 是否已完成初始积分同步
 * @type {boolean}
 */
let isInitialized = false;

/**
 * 从请求体中解析模型扣费信息（注意：这里提取的信息只用于 UI 展示，不作为计费依据）
 * 深度解析 metrics_extra.sceneOptions，提取 billingId、taskTypeName 等完整信息
 * @param {string} postData - POST 请求体字符串
 * @returns {{submit_id: string, billingId: string, taskType: string, taskTypeName: string, resolution: string, duration: number, prompt: string, timestamp: number, billed: boolean, real_cost: number, localCost: number}|null}
 */
function parseGenerateRequest(postData) {
    try {
        const body = JSON.parse(postData);
        const extend = body.extend || {};
        const draftContent = body.draft_content ? JSON.parse(body.draft_content) : null;

        const submitId = body.submit_id;
        if (!submitId) return null;

        // ──────────────────────────────────────────────
        // 深度解析 metrics_extra.sceneOptions（嵌套 JSON 字符串需二次解析）
        // ──────────────────────────────────────────────
        let sceneOptions = [];
        try {
            if (body.metrics_extra) {
                const metricsExtra = JSON.parse(body.metrics_extra);
                if (metricsExtra.sceneOptions) {
                    sceneOptions = JSON.parse(metricsExtra.sceneOptions);
                }
            }
        } catch (_) {}

        const firstScene = sceneOptions[0] || {};

        // ──────────────────────────────────────────────
        // 1. 提取计费标识 (billingId)
        //    优先 extend.m_video_commerce_info.benefit_type
        //    其次 sceneOptions[0].reportParams.extraVipFunctionKey
        // ──────────────────────────────────────────────
        let billingId = extend.m_video_commerce_info?.benefit_type
            || firstScene.reportParams?.extraVipFunctionKey
            || extend.root_model
            || '';
        billingId = String(billingId);

        // ──────────────────────────────────────────────
        // 2. 提取任务类型 (taskType / taskTypeName)
        //    sceneOptions[0].type === 'video' 或 draft_content 含 gen_video  → video
        //    含 audio / tts（配音类）                                              → audio
        //    默认                                                                           → image
        // ──────────────────────────────────────────────
        let taskType = 'image';
        let taskTypeName = '图片生成';
        const typeLower = (firstScene.type || '').toLowerCase();
        const draftLower = (body.draft_content || '').toLowerCase();

        if (typeLower === 'video' || draftLower.includes('gen_video')) {
            taskType = 'video';
            taskTypeName = '视频生成';
        } else if (typeLower.includes('audio') || typeLower.includes('tts') || draftLower.includes('audio') || draftLower.includes('tts')) {
            taskType = 'audio';
            taskTypeName = '音频配音';
        }

        // ──────────────────────────────────────────────
        // 3. 提取分辨率 (resolution)
        //    图片：draft_content...large_image_info.resolution_type 或 sceneOptions[0].resolutionType
        //    视频：sceneOptions[0].resolution
        // ──────────────────────────────────────────────
        let resolution = '';
        if (taskType === 'image' && draftContent) {
            const imgInfo = draftContent.component_list?.[0]?.abilities?.generate?.core_param?.large_image_info;
            if (imgInfo?.resolution_type) {
                resolution = imgInfo.resolution_type.toUpperCase();
            }
        }
        if (!resolution) {
            resolution = firstScene.resolutionType
                || firstScene.resolution
                || extend.resolution
                || body.resolution
                || '';
        }

        // ──────────────────────────────────────────────
        // 4. 提取时长（秒）(duration)
        //    优先 extend.m_video_commerce_info.amount
        //    其次在 draft_content 中匹配 duration_ms 除以 1000
        // ──────────────────────────────────────────────
        let duration = 0;
        if (extend.m_video_commerce_info?.amount) {
            duration = Number(extend.m_video_commerce_info.amount);
        }
        if (!duration && body.draft_content) {
            const msMatch = body.draft_content.match(/"duration_ms"\s*:\s*(\d+)/);
            if (msMatch) {
                duration = Math.round(Number(msMatch[1]) / 1000);
            }
        }

        // ──────────────────────────────────────────────
        // 5. 提取提示词 (prompt)，截取前30字
        //    优先通过正则从 draft_content 提取
        //    兜底从结构化路径提取
        // ──────────────────────────────────────────────
        let prompt = '';
        const promptMatch = body.draft_content?.match(/"prompt"\s*:\s*"([^"]+)"/);
        if (promptMatch) {
            prompt = promptMatch[1];
        }
        if (!prompt && draftContent) {
            if (taskType === 'image') {
                prompt = draftContent.component_list?.[0]?.abilities?.generate?.core_param?.prompt || '';
            } else if (taskType === 'video') {
                prompt = draftContent.component_list?.[0]?.abilities?.gen_video?.text_to_video_params?.video_gen_inputs?.[0]?.prompt || '';
            }
        }
        prompt = String(prompt).slice(0, 30);

        // ──────────────────────────────────────────────
        // 6. 本地字典即时映射扣量 (localCost)
        //    根据 billingId 或模型名直接返回预估扣量（仅用于 UI 展示，真实扣量以服务端为准）
        // ──────────────────────────────────────────────
        const localCost = getLocalCost(billingId, taskType);

        return {
            submit_id: submitId,
            billingId,
            taskType,
            taskTypeName,
            resolution,
            duration,
            prompt,
            timestamp: Date.now(),
            billed: false,
            real_cost: 0,
            localCost
        };
    } catch (e) {
        console.error('[CDP Interceptor] 解析生成请求失败:', e);
        return null;
    }
}

/**
 * 本地字典映射扣量
 * 根据计费标识或任务类型返回预估扣量（用于 UI 即时展示）
 * @param {string} billingId - 计费标识
 * @param {string} taskType - 任务类型
 * @returns {number} 预估扣量
 */
function getLocalCost(billingId, taskType) {
    const costMap = {
        // 图片生成
        'high_aes_general_v50-2k': 12,
        'high_aes_general_v40l-2k': 0,
        'high_aes_general_v50-1k': 5,
        'general_v20_2k': 8,
        'general_v20_1k': 3,
        'general_v20l_2k': 10,
        'general_v20l_1k': 4,
        // 视频生成
        'dreamina_video_seedance_20_pro': 44,
        'dreamina_video_seedance_20': 30,
        'dreamina_video_seedance_10_pro': 25,
        'dreamina_video_seedance_10': 15,
        'dreamina_video_jem5_5': 20,
        'dreamina_video_jem5_3': 12,
        'dreamina_video_jem5_1': 6,
        'video_v20l_seedance_4': 10,
        'video_v20l_seedance_8': 18,
        // 音频配音
        'tts_standard': 2,
        'tts_premium': 5,
        'audio_tts_standard': 2,
        'audio_tts_premium': 5,
    };

    if (billingId && costMap[billingId] !== undefined) {
        return costMap[billingId];
    }

    // 根据任务类型返回默认值
    if (taskType === 'video') return 15;
    if (taskType === 'audio') return 2;
    return 5; // image 默认
}

/**
 * 设置 CDP 拦截器
 * @param {Electron.BrowserWindow} win - Electron 窗口实例
 * @param {function} onPointsUpdate - 积分更新回调
 * @returns {{detach: function}} 分离函数
 */
function setupCdpInterceptor(win, onPointsUpdate) {
    const logger = {
        info: (...a) => console.log('[CDP Interceptor]', new Date().toLocaleTimeString('zh-CN', { hour12: false }), ...a),
        warn: (...a) => console.warn('[CDP Interceptor]', ...a),
        error: (...a) => console.error('[CDP Interceptor]', ...a),
    };

    let attached = false;
    let enabled = false;

    /**
     * 安全执行 CDP 调试命令
     * @param {string} cmd - 调试命令名
     * @param {object} params - 命令参数
     * @returns {Promise<object|null>}
     */
    async function safeCommand(cmd, params = {}) {
        if (!attached || !enabled || win.isDestroyed()) return null;
        try {
            return await win.webContents.debugger.sendCommand(cmd, params);
        } catch (e) {
            return null;
        }
    }

    /**
     * 处理请求：只记录本地发起的任务，绝对不在此刻计费
     * @param {object} params - CDP Network.requestWillBeSent 参数
     */
    async function handleRequestWillBeSent(params) {
        const url = params.request.url;

        if (url.includes('/mweb/v1/aigc_draft/generate') && params.request.method === 'POST') {
            const postDataStr = params.request.postData || '';
            if (!postDataStr) return;

            const parsed = parseGenerateRequest(postDataStr);
            if (!parsed) return;

            // 将任务存入本地专属池（初始化 billed=false, real_cost=0）
            rentTaskPool.set(parsed.submit_id, parsed);
            logger.info(`📝 已记录本地发起任务, submit_id=${parsed.submit_id}, ${parsed.taskTypeName}, 计费标识=${parsed.billingId || '默认'}, 预估扣量=${parsed.localCost}`);
        }
    }

    /**
     * 处理响应：拦截真实积分历史接口，通过 submit_id 精确匹配后触发计费
     * "即时扣费，失败返还" 三分支状态机
     * @param {object} params - CDP Network.responseReceived 参数
     */
    async function handleResponseReceived(params) {
        const url = params.response.url;
        const requestId = params.requestId;

        // 核心：拦截真实的积分历史接口
        if (url.includes('/commerce/v1/benefits/user_credit_history')) {
            const responseBody = await safeCommand('Network.getResponseBody', { requestId });
            if (!responseBody) return;

            try {
                const body = JSON.parse(responseBody.body);
                const records = body.data?.records || [];
                const totalCredit = body.data?.total_credit || 0;

                // 首次同步：初始化全局积分
                if (!isInitialized) {
                    isInitialized = true;
                    onPointsUpdate({ type: 'sync', currentPoints: totalCredit });
                    logger.info(`📊 初始积分同步完成: ${totalCredit}`);
                } else {
                    // 每次刷新都同步最新全局积分
                    onPointsUpdate({ type: 'sync', currentPoints: totalCredit });
                }

                for (const record of records) {
                    const submitId = record.submit_id;

                    // 核心过滤：不是本地发起的任务，或者已经处理过的任务，直接无视
                    if (!rentTaskPool.has(submitId) || completedTaskSet.has(submitId)) {
                        continue;
                    }

                    const taskInfo = rentTaskPool.get(submitId);

                    // 场景A：平台发起扣减（通常刚提交就会有一条 history_type=2 的记录）
                    // 此时 status 可能是 Init 或 Checked，只要尚未扣过费就触发即时扣费
                    if (record.history_type === 2 && !taskInfo.billed) {
                        logger.info(`⚡ 发现扣除记录，立即扣费，submit_id=${submitId}，扣量：${record.amount}`);
                        taskInfo.billed = true;
                        taskInfo.real_cost = record.amount; // 记录真实扣量，用于可能失败的返还

                        onPointsUpdate({
                            type: 'cost',
                            deduct: record.amount,
                            localCost: taskInfo.localCost,
                            billingId: taskInfo.billingId,
                            taskType: taskInfo.taskType,
                            taskTypeName: taskInfo.taskTypeName,
                            resolution: taskInfo.resolution,
                            duration: taskInfo.duration,
                            prompt: taskInfo.prompt
                        });
                    }

                    // 场景B：任务最终失败（status === 'CheckFailed'），执行积分返还补偿
                    else if (record.status === 'CheckFailed') {
                        logger.info(`❌ 任务失败，执行返还，submit_id=${submitId}`);
                        if (taskInfo.billed) {
                            onPointsUpdate({
                                type: 'refund',
                                refund: taskInfo.real_cost,
                                billingId: taskInfo.billingId,
                                taskType: taskInfo.taskType,
                                taskTypeName: taskInfo.taskTypeName
                            });
                        }
                        completedTaskSet.add(submitId);
                        rentTaskPool.delete(submitId);
                    }

                    // 场景C：任务圆满成功（status === 'Checked' 且已扣过费），直接清理内存
                    else if (record.status === 'Checked' && taskInfo.billed) {
                        logger.info(`✅ 任务圆满完成，闭环清理，submit_id=${submitId}`);
                        completedTaskSet.add(submitId);
                        rentTaskPool.delete(submitId);
                    }
                    // Init 状态且未扣费：保持沉默，等待后续轮询
                }

                // 兜底清理：极长超时（60小时 = 216000000ms）
                // 正常情况下任务会通过 Checked 或 CheckFailed 被即时清理
                const now = Date.now();
                for (const [submitId, task] of rentTaskPool) {
                    if (now - task.timestamp > 216000000) {
                        logger.warn(`🗑️ 任务滞留过久（超过60小时），执行兜底清理, submit_id=${submitId}`);
                        rentTaskPool.delete(submitId);
                    }
                }

            } catch (e) {
                logger.warn('积分历史响应解析失败:', e.message);
            }
        }
    }

    /**
     * CDP 调试消息处理器
     * @param {string} event - 事件类型
     * @param {string} method - CDP 方法名
     * @param {object} params - CDP 方法参数
     */
    function onDebuggerMessage(event, method, params) {
        if (method === 'Network.requestWillBeSent') handleRequestWillBeSent(params);
        else if (method === 'Network.responseReceived') handleResponseReceived(params);
    }

    // 挂载 CDP 调试器
    try {
        win.webContents.debugger.attach('1.3');
        attached = true;
        logger.info('CDP 调试器挂载成功');
    } catch (err) {
        logger.error('CDP 调试器挂载失败:', err.message);
        return { detach: () => {} };
    }

    win.webContents.debugger.on('message', onDebuggerMessage);
    win.webContents.debugger.sendCommand('Network.enable').then(() => {
        enabled = true;
        logger.info('Network 域已启用');
    });

    /**
     * 分离 CDP 拦截器，清理所有状态
     */
    function detach() {
        if (!attached) return;
        try {
            win.webContents.debugger.off('message', onDebuggerMessage);
            win.webContents.debugger.detach();
        } catch (e) {}
        rentTaskPool.clear();
        completedTaskSet.clear();
        isInitialized = false;
        attached = false;
        enabled = false;
        logger.info('CDP 拦截器已分离');
    }

    return { detach };
}

module.exports = { setupCdpInterceptor };

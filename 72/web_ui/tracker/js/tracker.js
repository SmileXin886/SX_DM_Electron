/**
 * tracker.js - 悬浮窗前端逻辑（Agent 逐条追溯版）
 *
 * Tab 架构：
 * - live（默认）：实时动态，包含 pending/核中/实时扣费/退款/Alien 碎片
 * - agent：Agent 已核算，逐条展示每个 submit_id 的正式任务卡片
 *
 * 追溯链路适配：
 * - agent_reconciler.js 不再发送 agent_task_settled 聚合事件
 * - 改为逐条发送 agent_task_settled_item，每个 submit_id 独立一张标准卡片
 *
 * 身份传承：prompt 来自 TaskLedger 原始记录（如"四只小狗"），禁止模糊兜底
 */
const state = {
    currentPoints: 0, totalCost: 0, totalRefund: 0, taskCount: 0,
    maxRecent: 20, winId: null, showGlobal: true,
    activeTab: 'live',
    settledItemCount: 0,
};

const els = {
    pointsValue: document.getElementById('points-value'),
    pointsDelta: document.getElementById('points-delta'),
    statTasks: document.getElementById('stat-tasks'),
    statCost: document.getElementById('stat-cost'),
    statRefund: document.getElementById('stat-refund'),
    taskList: document.getElementById('task-list'),
    btnLive: document.getElementById('btn-live'),
    btnAgent: document.getElementById('btn-agent'),
};

function formatNumber(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function updatePointsDisplay(value) { els.pointsValue.textContent = formatNumber(value); }

function showDelta(delta, type) {
    if (delta === 0) return;
    els.pointsDelta.classList.remove('hidden', 'deduct', 'refund', 'sync');
    els.pointsDelta.classList.add(type);
    const sign = delta > 0 ? '+' : '';
    els.pointsDelta.textContent = `${sign}${delta}`;
    setTimeout(() => { els.pointsDelta.classList.add('hidden'); }, 2000);
}

function updateStats() {
    els.statTasks.textContent = formatNumber(state.taskCount);
    els.statCost.textContent = formatNumber(state.totalCost);
    els.statRefund.textContent = formatNumber(state.totalRefund);
}

// ─────────────────────────────────────────────────────────────
// Tab 切换
// ─────────────────────────────────────────────────────────────
function switchTab(tab) {
    state.activeTab = tab;

    els.btnLive.classList.toggle('active', tab === 'live');
    els.btnAgent.classList.toggle('active', tab === 'agent');

    const allCards = els.taskList.querySelectorAll('.task-item');
    if (tab === 'live') {
        allCards.forEach(card => card.style.display = '');
    } else {
        allCards.forEach(card => {
            card.style.display = card.classList.contains('settled') ? '' : 'none';
        });
    }
}

// ─────────────────────────────────────────────────────────────
// 通用卡片渲染（标准任务卡片）
// isSettled 为 true 时：作为 Agent 追溯核算后的正式卡片渲染
// ─────────────────────────────────────────────────────────────
function buildCardHTML(task, isSettled) {
    const isPending = task.type === 'pending';
    // 🌟 修复1：精准判断 Agent，移除单纯的 isPending 条件，防止"常规任务"被错误显示为 Agent 图标
    const isAgent = task.data.agentMode || (task.data.taskTypeName && task.data.taskTypeName.includes('Agent'));
    const isRefunded = task.type === 'refund';

    let taskTypeClass = task.data.taskType || 'image';
    if (isAgent && !isRefunded) taskTypeClass = 'agent';
    else if (isRefunded) taskTypeClass = 'refund';

    let iconLetter = task.data.taskType === 'video' ? 'V' : task.data.taskType === 'audio' ? 'A' : 'I';
    if (isAgent) iconLetter = 'AG';
    if (isRefunded) iconLetter = 'R';

    // 1. 找到 costHtml 的生成逻辑，替换为以下代码：
    // 核心目的：如果是导入的普通历史任务，去掉紫色的"云端后续核算..."，留出干净的位置显示"进行中"
    let costHtml = '';
    if (isPending) {
        if (isAgent) {
            costHtml = `<div class="task-cost" style="color: #c084fc; font-size: 10px; animation: blink 2s infinite;">云端后续核算...</div>`;
        } else {
            // 常规历史任务不显示紫字
            costHtml = ``;
        }
    } else if (task.type === 'cost') {
        if (task.wasPending) {
            costHtml = `<div class="task-cost negative">-${task.cost} 积分</div>`;
        } else {
            costHtml = `<div class="task-cost negative">-${task.cost} 积分</div>`;
        }
    } else if (isRefunded) {
        costHtml = `<div class="task-cost positive">+${task.cost} 积分</div>`;
    }

    const taskTypeName = isRefunded ? '任务失败/取消' : (task.data.taskTypeName || '生成任务');

    // 🌟 新增：提取头像和昵称，构建账号徽章
    const nickname = task.data.nickname || '';
    const avatarPath = task.data.avatarPath || '';

    let accountBadgeHtml = '';
    if (nickname) {
        const fallbackSvg = `<svg viewBox="0 0 32 32" fill="none" style="width:100%;height:100%;"><circle cx="16" cy="16" r="16" fill="rgba(255,255,255,0.15)"/><path d="M16 16C18.2 16 20 14.2 20 12C20 9.8 18.2 8 16 8C13.8 8 12 9.8 12 12C12 14.2 13.8 16 16 16ZM16 18C13.3 18 8 19.3 8 22V24H24V22C24 19.3 18.7 18 16 18Z" fill="rgba(255,255,255,0.3)"/></svg>`;
        const avatarContent = avatarPath
            ? `<img src="file://${avatarPath}" style="width:14px; height:14px; border-radius:50%; object-fit:cover; display:block;">`
            : `<div style="width:14px; height:14px; border-radius:50%; display:flex; align-items:center; justify-content:center;">${fallbackSvg}</div>`;

        accountBadgeHtml = `
            <div style="display:flex; align-items:center; gap:4px; margin-left: 6px; padding: 2px 6px; background: rgba(255,255,255,0.06); border-radius: 10px; border: 1px solid rgba(255,255,255,0.03);">
                ${avatarContent}
                <span style="font-size: 9px; color: rgba(255,255,255,0.65); max-width: 60px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1;">${nickname}</span>
            </div>
        `;
    }

    // 🌟 修复2：强制拦截导入的历史任务，根据 billed 状态精准区分提示词和颜色
    let promptHtml = '';
    if (task.data.isRecovered) {
        if (task.data.billed) {
             // 已经扣过费的 (billed: true) -> 保持原有的亮绿色
             promptHtml = `<span style="color: #10b981; font-weight: bold;" title="已扣费，等待完结">仅云端追踪任务进度无扣分</span>`;
        } else {
             // 还没扣费、遗漏需要补扣的 (billed: false) -> 换成醒目的紫色
             promptHtml = `<span style="color: #c084fc; font-weight: bold;" title="防秒退拦截，等待云端扣费">云端检测到遗漏账单需扣分</span>`;
        }
    } else {
         const promptText = task.data.prompt || '-';
         promptHtml = `<span title="${promptText}">${String(promptText).slice(0, 15)}${promptText.length > 15 ? '...' : ''}</span>`;
    }
    const rawBillingId = task.data.billingId || '-';
    const displayModel = (rawBillingId === 'auto_catch' || rawBillingId === 'alien_task') ? 'Agent 动态分配' : rawBillingId;

    let idDisplayRow = '';
    if (isPending) {
        // 🌟 修复3：根据是否为 Agent 区分显示文字，常规任务不显示"核算ID"
        const idLabel = isAgent ? '核算ID' : '任务ID';
        const idColor = isAgent ? '#c084fc' : '#00cAE0';
        const displayId = task.data.userMessageId || task.data.submit_id || '获取中...';
        idDisplayRow = `<div class="detail-row"><span class="detail-label">${idLabel}</span><span class="detail-value" style="color: ${idColor}; font-family: 'Consolas', monospace;">${displayId}</span></div>`;
    } else {
        idDisplayRow = `<div class="detail-row"><span class="detail-label">任务ID</span><span class="detail-value" style="color: #00cAE0; font-family: 'Consolas', monospace;">${task.data.submit_id || task.data.userMessageId || '获取中...'}</span></div>`;
    }

    const alienTagHtml = task.data.isAlien ?
        `<span class="alien-badge">他人生成</span>` : '';

    // ==========================================
    // 🌟 新增：内部详情时间行（紧跟在 ID 下方）
    // ==========================================
    let timeRowHtml = '';
    if (!task.data.isAlien && task.data.timestamp) {
        const d = new Date(task.data.timestamp);
        const pad = n => n < 10 ? '0' + n : n;
        const timeStr = `${d.getFullYear()}年${pad(d.getMonth() + 1)}月${pad(d.getDate())}日 ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        timeRowHtml = `<div class="detail-row"><span class="detail-label">触发时间</span><span class="detail-value">${timeStr}</span></div>`;
    }

    // ==========================================
    // 🌟 核心：专门给标准生图/视频任务加的状态标
    // 只在非 Agent 且 非退款 且 是扣费卡片 时显示
    // ==========================================
    // 2. 往下找，找到 statusBadgeHtml 的生成逻辑，替换为以下代码：
    // 核心目的：允许 isPending 的普通任务也挂载 standard-status 标签，这样底层的"完结/取消"事件就能完美找到它并变色！
    let statusBadgeHtml = '';
    if (!isAgent && !isRefunded) {
        // 只要是扣费卡片，或者是恢复出来的待处理卡片 (isPending)，都赋予"进行中"状态标
        if (task.type === 'cost' || isPending) {
            statusBadgeHtml = `<span class="standard-status" style="font-size: 11px; color: #00cAE0; margin-right: 8px; font-weight: bold; animation: blink 2s infinite; white-space: nowrap;">进行中...</span>`;
        }
    }

    return `
        <div class="task-header">
            <div class="task-header-left" style="min-width: 0;">
                <div class="task-icon ${taskTypeClass}">${iconLetter}</div>
                <span style="max-width: 90px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${taskTypeName}</span>
                ${accountBadgeHtml}
                ${alienTagHtml}
            </div>
            <div style="display: flex; align-items: center; flex-shrink: 0;">
                ${statusBadgeHtml}
                ${costHtml}
            </div>
        </div>
        <div class="task-details-box">
            ${idDisplayRow}
            ${timeRowHtml}
            ${(!isPending && displayModel && displayModel !== '-') ? `<div class="detail-row"><span class="detail-label">模型</span><span class="detail-value">${displayModel}</span></div>` : ''}
            ${(!isPending && task.data.resolution && task.data.resolution !== '-') ? `<div class="detail-row"><span class="detail-label">分辨率</span><span class="detail-value">${task.data.resolution}</span></div>` : ''}
            ${(!isPending && task.data.duration) ? `<div class="detail-row"><span class="detail-label">时长</span><span class="detail-value">${task.data.duration} 秒</span></div>` : ''}
            <div class="detail-row"><span class="detail-label">提示词</span><span class="detail-value">${promptHtml}</span></div>
        </div>`;
}

/**
 * 渲染实时动态任务记录
 */
function appendTaskRecord(task) {
    const empty = els.taskList.querySelector('.task-empty');
    if (empty) empty.remove();

    // 🌟 防重叠微调：如果是防秒退触发的真实扣费事件，把刚刚启动时生成的"恢复卡片"替换掉！
    if (task.type === 'cost' && task.data && task.data.submit_id) {
        const oldCard = els.taskList.querySelector(`.task-item[data-submit-id="${task.data.submit_id}"]`);
        if (oldCard) oldCard.remove();
    }

    // ==========================================
    // 🌟 核心修复区：Agent Pending 卡片防重叠逻辑
    // ==========================================
    if (task.type === 'pending' && task.data && task.data.userMessageId) {
        // 检查 DOM 中是否已经存在相同 userMessageId 的"核算中"卡片
        const existPending = els.taskList.querySelector(`.task-item.pending[data-umid="${task.data.userMessageId}"]`);
        if (existPending) {
            // 如果已经有了，直接拦截，拒绝重复生成卡片
            return;
        }
    }

    const pendingUmid = (task.type === 'cost' || task.type === 'refund') ? task.data.userMessageId : null;
    const pendingNodes = pendingUmid
        ? Array.from(els.taskList.querySelectorAll(`.task-item.pending[data-umid="${pendingUmid}"]`))
        : [];

    const item = document.createElement('div');
    item.className = 'task-item';
    if (task.data && task.data.submit_id) item.setAttribute('data-submit-id', task.data.submit_id);

    const isPending = task.type === 'pending';
    if (isPending && task.data.userMessageId) {
        item.classList.add('pending');
        item.setAttribute('data-umid', task.data.userMessageId);
    }
    if (task.data.isAlien) item.classList.add('alien-task');

    item.innerHTML = buildCardHTML(task, false);

    if (state.activeTab !== 'live') {
        item.style.display = 'none';
    }

    els.taskList.insertBefore(item, els.taskList.firstChild);

    // 维持最近任务的最大数量
    while (els.taskList.children.length > state.maxRecent) els.taskList.lastChild.remove();
}

/**
 * 渲染已核算 Agent 逐条任务卡片
 *
 * 每个 submit_id 独立一张标准任务卡片（与普通任务卡片格式一致）
 * 不再合并为"总扣费"聚合卡
 *
 * 身份传承：prompt 来自 TaskLedger 原始记录，严禁止模糊兜底
 */
function appendSettledItem(data) {
    const userMessageId = data.userMessageId || '';

    // 只追加卡片，不再删除 pending 卡片（pending 卡由 agent_task_fully_settled 统一清理）
    const empty = els.taskList.querySelector('.task-empty');
    if (empty) empty.remove();

    state.settledItemCount += 1;
    els.btnAgent.innerHTML = `<span class="tab-dot agent-dot"></span>Agent 已核算 <span style="margin-left:4px; font-size:10px; background:rgba(192,132,252,0.2); color:#c084fc; padding:1px 5px; border-radius:8px;">${state.settledItemCount}</span>`;

    const item = document.createElement('div');
    item.className = 'task-item settled';
    item.setAttribute('data-umid', userMessageId);

    const rawPrompt = data.prompt;
    const cardData = {
        submit_id: data.submit_id || '-',
        userMessageId: userMessageId,
        prompt: rawPrompt || '',
        taskTypeName: data.agentMode || data.taskTypeName || 'Agent 任务',
        billingId: data.billingId || 'auto_catch',
        taskType: data.taskType || 'image',
        resolution: data.resolution || '-',
        duration: data.duration || 0,
        isAlien: false,
        agentMode: data.agentMode || '',
        nickname: data.nickname, avatarPath: data.avatarPath
    };

    const record = {
        type: 'cost',
        cost: data.deduct || 0,
        data: cardData,
    };

    item.innerHTML = buildCardHTML(record, true);

    const detailsBox = item.querySelector('.task-details-box');
    if (detailsBox) {
        const badge = document.createElement('div');
        badge.className = 'detail-row settled-tag-row';
        badge.innerHTML = `<span class="detail-label">核算</span><span class="detail-value settled-tag">追溯核算</span>`;
        detailsBox.appendChild(badge);
    }

    if (state.activeTab !== 'agent') {
        item.style.display = 'none';
    }

    els.taskList.insertBefore(item, els.taskList.firstChild);
    while (els.taskList.children.length > state.maxRecent) els.taskList.lastChild.remove();
}

// ─────────────────────────────────────────────────────────────
// 事件分发
// ─────────────────────────────────────────────────────────────
function handlePointsUpdate(data) {
    const { type } = data;

    if (type === 'init') {
        state.winId = data.winId;
        return;
    }

    // 🌟 新增 UI 监听：收到标准任务完结信号，只负责把字变成绿色！
    if (type === 'standard_task_finished') {
        const sid = data.submit_id;
        if (sid) {
            const cards = els.taskList.querySelectorAll(`.task-item[data-submit-id="${sid}"]`);
            cards.forEach(card => {
                const statusEl = card.querySelector('.standard-status');
                if (statusEl) {
                    statusEl.innerHTML = `✅ 已完结`;
                    statusEl.style.color = '#10b981'; // 官方同款绿
                    statusEl.style.animation = 'none'; // 停止闪烁
                }
            });
        }
        return;
    }

    if (type === 'pending_display') {
        appendTaskRecord({
            type: 'pending',
            cost: '核算中',
            data: data
        });
        return;
    }

    // 逐条追溯事件：每个 submit_id 独立一张标准卡片
    if (type === 'agent_task_settled_item') {
        // 🌟 如果这个任务之前被 CDP 误判为常规任务并在实时列表中显示了，把它删掉！
        const wrongCard = els.taskList.querySelector(`.task-item:not(.settled)[data-submit-id="${data.submit_id}"]`);
        if (wrongCard) wrongCard.remove();

        // ==========================================
        // 🌟 核心修复：将认领回来的 Agent 任务数据补录到顶部统计面板
        // ==========================================
        const cost = Math.abs(data.deduct || 0);
        if (cost > 0) {
            state.taskCount += 1;
            state.totalCost += cost;
            updateStats();
            // 注：这里故意不调用 showDelta(-cost) 动画，因为追溯数据通常是批量涌入的，不显示飘字动画可以防止 UI 闪烁卡顿。
        }

        appendSettledItem(data);
        return;
    }

    // 主任务彻底完结：此时才允许删除 pending 卡片
    if (type === 'agent_task_fully_settled') {
        const umid = data.userMessageId;
        if (umid) {
            const pendingCard = els.taskList.querySelector(`.task-item.pending[data-umid="${umid}"]`);
            if (pendingCard) {
                pendingCard.classList.remove('pending');
                pendingCard.classList.add('fully-settled');
                pendingCard.style.borderLeft = '3px solid #10b981';
                const detailsBox = pendingCard.querySelector('.task-details-box');
                if (detailsBox) {
                    const costEl = pendingCard.querySelector('.task-cost');
                    if (costEl) costEl.innerHTML = `<span style="color: #10b981;">✅ 已全核算</span>`;
                }
            }
        }
        return;
    }

    if (type === 'sync') {
        if (typeof data.currentPoints === 'number') {
            const old = state.currentPoints;
            state.currentPoints = data.currentPoints;
            updatePointsDisplay(data.currentPoints);
            const delta = data.currentPoints - old;
            if (delta !== 0) showDelta(delta, 'sync');
        }
        return;
    }

    if (type === 'cost') {
        const cost = Math.abs(data.deduct || 0);

        // 1. 云端真实扣费来了！老老实实计入顶部总计分面板！
        if (!data.isAlien && !data.isRecovered) {
            state.taskCount += 1;
            state.totalCost += cost;
            showDelta(-cost, 'cost');
            updateStats();
        }

        // 2. 核心修复：拿到云端真实分数后，原地找老卡片修改，坚决不重绘卡片，完美保留"✅ 已完结"！
        if (data.submit_id) {
            const existingCard = els.taskList.querySelector(`.task-item[data-submit-id="${data.submit_id}"]`);
            if (existingCard) {
                // 原地把右侧空白处填入真实的负分红字
                let costContainer = existingCard.querySelector('.task-cost');
                if (!costContainer) {
                    const rightArea = existingCard.querySelector('.task-header > div:last-child');
                    if (rightArea) {
                        rightArea.insertAdjacentHTML('beforeend', `<div class="task-cost negative">-${cost} 积分</div>`);
                    }
                } else {
                    costContainer.className = 'task-cost negative';
                    costContainer.innerHTML = `-${cost} 积分`;
                }

                // 任务已正式核算扣费，把绿色的"历史无扣费"提示还原为原本真实的提示词
                const promptSpan = existingCard.querySelector('.detail-value span[title="本地账单恢复的追溯任务"]');
                if (promptSpan) {
                    const realPrompt = data.prompt || '-';
                    promptSpan.textContent = String(realPrompt).slice(0, 15) + (realPrompt.length > 15 ? '...' : '');
                    promptSpan.title = realPrompt;
                    promptSpan.style.color = '';
                    promptSpan.style.fontWeight = '';
                }

                return; // 极其重要：原地打补丁完毕后直接 return，绝对不再生成或覆盖新卡片！
            }
        }

        // 3. 兜底：如果没找到老卡片，说明是全新产生的实时任务，正常走新建流程
        const cardData = {
            taskType: data.taskType, taskTypeName: data.taskTypeName, billingId: data.billingId,
            resolution: data.resolution, duration: data.duration, prompt: data.prompt,
            timestamp: data.timestamp, isAlien: data.isAlien, submit_id: data.submit_id,
            userMessageId: data.userMessageId, agentMode: data.agentMode,
            nickname: data.nickname, avatarPath: data.avatarPath,
            isRecovered: data.isRecovered
        };

        appendTaskRecord({
            type: 'cost', cost: cost,
            data: cardData
        });
        return;
    }

    if (type === 'refund') {
        // 🌟 UI 细节补充：如果在进行中途用户取消了，触发了返还
        // 把老卡片上的"进行中"改成"已取消"，防止它一直闪
        if (data.submit_id) {
            const oldCards = els.taskList.querySelectorAll(`.task-item[data-submit-id="${data.submit_id}"]`);
            oldCards.forEach(card => {
                const statusEl = card.querySelector('.standard-status');
                if (statusEl && statusEl.innerHTML.includes('进行中')) {
                    statusEl.innerHTML = `已取消`;
                    statusEl.style.color = '#f0b429'; // 警告黄
                    statusEl.style.animation = 'none';
                }
            });
        }

        const refund = Math.abs(data.refund || 0);
        if (!data.isAlien) {
            state.totalRefund += refund;
            showDelta(refund, 'refund');
            updateStats();
        }

        appendTaskRecord({
            type: 'refund', cost: refund,
            data: {
                taskType: data.taskType || '', taskTypeName: data.taskTypeName || '退款任务',
                prompt: data.prompt, isAlien: data.isAlien, submit_id: data.submit_id,
                userMessageId: data.userMessageId, agentMode: data.agentMode,
                resolution: data.resolution, duration: data.duration, timestamp: data.timestamp,
                nickname: data.nickname, avatarPath: data.avatarPath
            }
        });
        return;
    }
}

// ─────────────────────────────────────────────────────────────
// 初始化
// ─────────────────────────────────────────────────────────────
function setupIPCReceiver() { window.electron.on('tracker:update-points', handlePointsUpdate); }

function init() {
    setupIPCReceiver();
    updateStats();
    updatePointsDisplay(state.currentPoints);

    // 初始化账号头像/昵称组件
    if (typeof ProfileWidget !== 'undefined') {
        new ProfileWidget('profile-widget');
    }

    els.btnLive.addEventListener('click', () => switchTab('live'));
    els.btnAgent.addEventListener('click', () => switchTab('agent'));

    // 强制对账按钮
    const btnForce = document.getElementById('btn-force-reconcile');
    if (btnForce) {
        btnForce.addEventListener('click', () => {
            if (btnForce.classList.contains('spinning')) return;
            btnForce.classList.add('spinning');

            // 1. 原有的 Agent 强制追溯对账（底层账本逻辑）
            window.electron.send('tracker:force-reconcile', {});

            // 2. 🌟 新增：找出所有 UI 上卡在"进行中..."的普通任务，让后台强行查岗！
            const sidsToCheck = [];
            const activeStandardCards = els.taskList.querySelectorAll('.task-item');
            activeStandardCards.forEach(card => {
                const statusEl = card.querySelector('.standard-status');
                if (statusEl && statusEl.innerHTML.includes('进行中')) {
                    const sid = card.getAttribute('data-submit-id');
                    if (sid) sidsToCheck.push(sid);
                }
            });
            if (sidsToCheck.length > 0) {
                window.electron.send('tracker:check-standard-tasks', { submitIds: sidsToCheck });
            }

            setTimeout(() => btnForce.classList.remove('spinning'), 1000);
        });
    }

    const toggleEl = document.getElementById('toggle-global');
    if (toggleEl) {
        if (!toggleEl.checked) els.taskList.classList.add('hide-alien');

        toggleEl.addEventListener('change', (e) => {
            state.showGlobal = e.target.checked;
            if (state.showGlobal) {
                els.taskList.classList.remove('hide-alien');
            } else {
                els.taskList.classList.add('hide-alien');
            }
            // 核心修复：彻底删除了 window.electron.send('tracker:toggle-global'...)
            // UI 开关只负责前端隐藏，绝不允许它去控制后端心跳的生杀大权！
        });
    }

    const style = document.createElement('style');
    style.textContent = `
        #task-list.hide-alien .alien-task { display: none !important; }
        .alien-badge { font-size: 10px; color: #f0b429; background: rgba(240, 180, 41, 0.15); padding: 2px 6px; border-radius: 4px; margin-left: 8px; font-weight: 500; }
        .task-item.settled { border-left: 3px solid #c084fc; background: rgba(192, 132, 252, 0.07); }
        .task-item.fully-settled { border-left: 3px solid #10b981; background: rgba(16, 185, 129, 0.07); }
        .settled-tag { color: #c084fc !important; font-weight: 600 !important; font-size: 10px !important; }
        .settled-tag-row { margin-top: 2px; }
    `;
    document.head.appendChild(style);
}

document.addEventListener('DOMContentLoaded', init);

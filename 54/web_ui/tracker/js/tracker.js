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
    const isAgent = task.data.agentMode || isPending || (task.data.taskTypeName && task.data.taskTypeName.includes('Agent'));
    const isRefunded = task.type === 'refund';

    let taskTypeClass = task.data.taskType || 'image';
    if (isAgent && !isRefunded) taskTypeClass = 'agent';
    else if (isRefunded) taskTypeClass = 'refund';

    let iconLetter = task.data.taskType === 'video' ? 'V' : task.data.taskType === 'audio' ? 'A' : 'I';
    if (isAgent) iconLetter = 'AG';
    if (isRefunded) iconLetter = 'R';

    let costHtml = '';
    if (isPending) {
        costHtml = `<div class="task-cost" style="color: #c084fc; font-size: 10px; animation: blink 2s infinite;">云端后续核算...</div>`;
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
    const promptText = task.data.prompt || '-';
    const rawBillingId = task.data.billingId || '-';
    const displayModel = (rawBillingId === 'auto_catch' || rawBillingId === 'alien_task') ? 'Agent 动态分配' : rawBillingId;

    let idDisplayRow = '';
    if (isPending) {
        idDisplayRow = `<div class="detail-row"><span class="detail-label">核算ID</span><span class="detail-value" style="color: #c084fc; font-family: 'Consolas', monospace;">${task.data.userMessageId || '获取中...'}</span></div>`;
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
    let statusBadgeHtml = '';
    if (!isAgent && !isRefunded && !isPending && task.type === 'cost') {
        statusBadgeHtml = `<span class="standard-status" style="font-size: 11px; color: #00cAE0; margin-right: 8px; font-weight: bold; animation: blink 2s infinite; white-space: nowrap;">进行中...</span>`;
    }

    return `
        <div class="task-header">
            <div class="task-header-left" style="min-width: 0;">
                <div class="task-icon ${taskTypeClass}">${iconLetter}</div>
                <span style="max-width: 90px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${taskTypeName}</span>
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
            <div class="detail-row"><span class="detail-label">提示词</span><span class="detail-value" title="${promptText}">${String(promptText).slice(0, 15)}${promptText.length > 15 ? '...' : ''}</span></div>
        </div>`;
}

/**
 * 渲染实时动态任务记录
 */
function appendTaskRecord(task) {
    const empty = els.taskList.querySelector('.task-empty');
    if (empty) empty.remove();

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
        if (!data.isAlien) {
            state.taskCount += 1;
            state.totalCost += cost;
            showDelta(-cost, 'cost');
            updateStats();
        }

        const cardData = {
            taskType: data.taskType, taskTypeName: data.taskTypeName, billingId: data.billingId,
            resolution: data.resolution, duration: data.duration, prompt: data.prompt,
            timestamp: data.timestamp, isAlien: data.isAlien, submit_id: data.submit_id,
            userMessageId: data.userMessageId, agentMode: data.agentMode
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
                resolution: data.resolution, duration: data.duration, timestamp: data.timestamp
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
            if (state.winId !== null) {
                window.electron.send('tracker:toggle-global', { winId: state.winId, state: state.showGlobal });
            }
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

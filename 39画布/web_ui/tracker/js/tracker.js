/**
 * tracker.js - 悬浮窗前端逻辑 (流水线纯净展示版)
 */
const state = {
    currentPoints: 0, totalCost: 0, totalRefund: 0, taskCount: 0,
    maxRecent: 15, winId: null, showGlobal: true 
};

const els = {
    pointsValue: document.getElementById('points-value'),
    pointsDelta: document.getElementById('points-delta'),
    statTasks: document.getElementById('stat-tasks'),
    statCost: document.getElementById('stat-cost'),
    statRefund: document.getElementById('stat-refund'),
    taskList: document.getElementById('task-list'),
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

// 🌟 核心：永远生成新的卡片节点，绝不去修改和覆盖历史的 DOM！
function appendTaskRecord(task) {
    const empty = els.taskList.querySelector('.task-empty');
    if (empty) empty.remove();

    // 🌟 核心：如果这是正式扣费账单，且带了 userMessageId，
    // 批量清除所有匹配的"核算中"占位卡片（1 个 userMessageId 可能对应多个 submit_id）
    if ((task.type === 'cost' || task.type === 'refund') && task.data.userMessageId) {
        const pendingNodes = document.querySelectorAll(`.task-item.pending[data-umid="${task.data.userMessageId}"]`);
        if (pendingNodes.length > 0) {
            pendingNodes.forEach(node => node.remove());
            task.wasPending = true; // 标记：这批结果是由核算中转化而来的
        }
    }

    const item = document.createElement('div');
    item.className = 'task-item';

    // 如果是核算占位，加上专属 class 和 umid 供以后查杀
    const isPending = task.type === 'pending';
    if (isPending && task.data.userMessageId) {
        item.classList.add('pending');
        item.setAttribute('data-umid', task.data.userMessageId);
    }

    // 他人任务专属 class，用于被顶部开关控制显示/隐藏
    if (task.data.isAlien) item.classList.add('alien-task');

    const isAgent = task.data.agentMode || isPending || (task.data.taskTypeName && task.data.taskTypeName.includes('Agent'));
    let taskTypeClass = task.data.taskType || 'image';
    if (isAgent && task.type !== 'refund') taskTypeClass = 'agent';
    else if (task.type === 'refund') taskTypeClass = 'refund';

    let iconLetter = task.data.taskType === 'video' ? 'V' : task.data.taskType === 'audio' ? 'A' : 'I';
    if (isAgent) iconLetter = 'AG';
    if (task.type === 'refund') iconLetter = 'R';

    // 🌟 动态价格文案渲染
    let costHtml = '';
    if (isPending) {
        costHtml = `<div class="task-cost" style="color: #c084fc; font-size: 10px; animation: blink 2s infinite;">云端后续核算...</div>`;
    } else if (task.type === 'cost') {
        if (task.wasPending) {
            // 核算大成功！紫字炫耀！
            costHtml = `<div class="task-cost negative">-${task.cost} 积分<br><span style="font-size:9px; color:#c084fc; font-weight:normal;">(已核算!)</span></div>`;
        } else {
            costHtml = `<div class="task-cost negative">-${task.cost} 积分</div>`;
        }
    } else if (task.type === 'refund') {
        costHtml = `<div class="task-cost positive">+${task.cost} 积分</div>`;
    }

    const taskTypeName = task.type === 'refund' ? '任务失败/取消' : (task.data.taskTypeName || '生成任务');
    const promptText = task.data.prompt || '-';
    const rawBillingId = task.data.billingId || '-';

    // 🌟 模型显示优化
    const displayModel = (rawBillingId === 'auto_catch' || rawBillingId === 'alien_task') ? 'Agent 动态分配' : rawBillingId;

    // 🌟 产物类型解析（带紫色强调色的文案）
    let subTypeStr = '图片生成';
    if (task.data.taskType === 'video') subTypeStr = '视频生成';
    else if (task.data.taskType === 'audio') subTypeStr = '音频配音';

    // 🌟 ID 分类显示
    let idDisplayRow = '';
    if (isPending) {
        const displayId = task.data.userMessageId || '获取中...';
        idDisplayRow = `<div class="detail-row"><span class="detail-label">核算ID</span><span class="detail-value" style="color: #c084fc; font-family: 'Consolas', monospace;">${displayId}</span></div>`;
    } else {
        const displayId = task.data.submit_id || task.data.userMessageId || '获取中...';
        idDisplayRow = `<div class="detail-row"><span class="detail-label">任务ID</span><span class="detail-value" style="color: #00cAE0; font-family: 'Consolas', monospace;">${displayId}</span></div>`;
    }

    const alienTagHtml = task.data.isAlien ?
        `<span class="alien-badge" style="font-size: 10px; color: #f0b429; background: rgba(240, 180, 41, 0.15); padding: 2px 6px; border-radius: 4px; margin-left: 8px; font-weight: 500;">他人生成任务</span>` : '';

    // 完整注入 DOM，没有任何信息会被吞！
    item.innerHTML = `
        <div class="task-header">
            <div class="task-header-left">
                <div class="task-icon ${taskTypeClass}">${iconLetter}</div>
                <span style="max-width: 130px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${taskTypeName}</span>
                ${alienTagHtml}
            </div>
            ${costHtml}
        </div>
        <div class="task-details-box">
            ${idDisplayRow}

            ${(!isPending && isAgent) ? `
            <div class="detail-row">
                <span class="detail-label">类型</span>
                <span class="detail-value" style="color: #c084fc; font-weight: bold;">${subTypeStr}</span>
            </div>` : ''}

            ${(!isPending && displayModel && displayModel !== '-') ? `
            <div class="detail-row">
                <span class="detail-label">模型</span>
                <span class="detail-value">${displayModel}</span>
            </div>` : ''}

            ${(!isPending && task.data.resolution && task.data.resolution !== '-') ? `
            <div class="detail-row">
                <span class="detail-label">分辨率</span>
                <span class="detail-value">${task.data.resolution}</span>
            </div>` : ''}

            ${(!isPending && task.data.duration) ? `
            <div class="detail-row">
                <span class="detail-label">时长</span>
                <span class="detail-value">${task.data.duration} 秒</span>
            </div>` : ''}

            <div class="detail-row">
                <span class="detail-label">提示词</span>
                <span class="detail-value" title="${promptText}">${String(promptText).slice(0, 15)}${promptText.length > 15 ? '...' : ''}</span>
            </div>
        </div>
    `;

    els.taskList.insertBefore(item, els.taskList.firstChild);
    while (els.taskList.children.length > state.maxRecent) els.taskList.lastChild.remove();
}

function handlePointsUpdate(data) {
    const { type } = data;

    if (type === 'init') { state.winId = data.winId; return; }

    // 🌟 核心新增：处理待核算任务的占位显示
    if (type === 'pending_display') {
        appendTaskRecord({
            type: 'pending',
            cost: '核算中',
            data: data
        });
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
    } else if (type === 'cost') {
        const cost = Math.abs(data.deduct || 0);

        // 🌟 只有自己的任务，才算入统计大盘
        if (!data.isAlien) {
            state.taskCount += 1;
            state.totalCost += cost;
            showDelta(-cost, 'cost');
            updateStats();
        }

        appendTaskRecord({
            type: 'cost', cost: cost,
            data: {
                taskType: data.taskType, taskTypeName: data.taskTypeName, billingId: data.billingId,
                resolution: data.resolution, duration: data.duration, prompt: data.prompt,
                timestamp: data.timestamp, isAlien: data.isAlien, submit_id: data.submit_id, userMessageId: data.userMessageId,
                agentMode: data.agentMode
            }
        });
    } else if (type === 'refund') {
        const refund = Math.abs(data.refund || 0);

        // 🌟 只有自己的任务，才算入统计大盘
        if (!data.isAlien) {
            state.totalRefund += refund;
            showDelta(refund, 'refund');
            updateStats();
        }

        appendTaskRecord({
            type: 'refund', cost: refund,
            data: { 
                taskType: data.taskType || '', taskTypeName: data.taskTypeName || '退款任务', 
                prompt: data.prompt, isAlien: data.isAlien, submit_id: data.submit_id, userMessageId: data.userMessageId,
                agentMode: data.agentMode, resolution: data.resolution, duration: data.duration, timestamp: data.timestamp
            }
        });
    }
}

function setupIPCReceiver() { window.electron.on('tracker:update-points', handlePointsUpdate); }

function init() {
    setupIPCReceiver();
    updateStats();
    updatePointsDisplay(state.currentPoints);

    const style = document.createElement('style');
    style.textContent = `
        #task-list.hide-alien .alien-task {
            display: none !important;
        }
    `;
    document.head.appendChild(style);

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
}

document.addEventListener('DOMContentLoaded', init);
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

    const item = document.createElement('div');
    item.className = 'task-item';
    
    // 他人任务专属 class，用于被顶部开关控制显示/隐藏
    if (task.data.isAlien) item.classList.add('alien-task');

    const alienTagHtml = task.data.isAlien ?
        `<span style="font-size: 10px; color: #f0b429; background: rgba(240, 180, 41, 0.15); padding: 2px 6px; border-radius: 4px; margin-left: 8px; font-weight: 500; border: 1px solid rgba(240, 180, 41, 0.3);">他人生成任务</span>` : '';

    const timeInHeader = (!task.data.isAlien && task.data.timestamp) ? (() => {
        const d = new Date(task.data.timestamp);
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    })() : '';

    // 🌟 ID 的极简分类法则：标题里带了 Agent 或者是通过 userMessageId 定位的，就是核算ID(紫)。否则就是任务ID(青)。
    const isAgent = task.data.agentMode || (task.data.taskTypeName && task.data.taskTypeName.includes('Agent')) || (task.data.userMessageId && !task.data.submit_id && !task.data.isAlien);

    let idDisplayRow = '';
    if (isAgent) {
        const displayId = task.data.userMessageId || task.data.submit_id || '获取中...';
        idDisplayRow = `
            <div class="detail-row">
                <span class="detail-label">核算ID</span>
                <span class="detail-value" style="color: #c084fc; font-family: 'Consolas', monospace;">${displayId}</span>
            </div>`;
    } else {
        const displayId = task.data.submit_id || task.data.userMessageId || '获取中...';
        idDisplayRow = `
            <div class="detail-row">
                <span class="detail-label">任务ID</span>
                <span class="detail-value" style="color: #00cAE0; font-family: 'Consolas', monospace;">${displayId}</span>
            </div>`;
    }

    const taskTypeName = task.type === 'refund' ? '任务失败/取消' : (task.data.taskTypeName || '生成任务');
    const taskTypeClass = task.type === 'refund' ? 'refund' : (task.data.taskType || 'image');
    let iconLetter = task.data.taskType === 'video' ? 'V' : task.data.taskType === 'audio' ? 'A' : 'I';
    if (task.type === 'refund') iconLetter = 'R'; 

    let costHtml = '';
    if (task.type === 'cost') {
        costHtml = `<div class="task-cost negative">-${task.cost} 积分</div>`;
    } else if (task.type === 'refund') {
        costHtml = `<div class="task-cost positive">+${task.cost} 积分</div>`;
    }

    // 完整注入 DOM，没有任何信息会被吞！
    item.innerHTML = `
        <div class="task-header">
            <div class="task-header-left">
                <div class="task-icon ${taskTypeClass}">${iconLetter}</div>
                <span>${taskTypeName}</span>
                ${alienTagHtml}
                ${timeInHeader ? `<span style="font-size: 10px; color: #fff; margin-left: 6px;">${timeInHeader}</span>` : ''}
            </div>
            ${costHtml}
        </div>
        <div class="task-details-box">
            ${idDisplayRow}
            ${task.data.billingId && task.data.billingId !== 'auto_catch' ? `
            <div class="detail-row">
                <span class="detail-label">计费标识</span>
                <span class="detail-value">${task.data.billingId}</span>
            </div>` : ''}
            ${task.data.resolution && task.data.resolution !== '-' ? `
            <div class="detail-row">
                <span class="detail-label">分辨率</span>
                <span class="detail-value">${task.data.resolution}</span>
            </div>` : ''}
            ${task.data.duration ? `
            <div class="detail-row">
                <span class="detail-label">时长</span>
                <span class="detail-value">${task.data.duration} 秒</span>
            </div>` : ''}
            <div class="detail-row">
                <span class="detail-label">提示词</span>
                <span class="detail-value">${task.data.prompt || '无'}</span>
            </div>
        </div>
    `;

    els.taskList.insertBefore(item, els.taskList.firstChild);
    while (els.taskList.children.length > state.maxRecent) els.taskList.lastChild.remove();
}

function handlePointsUpdate(data) {
    const { type } = data;

    if (type === 'init') { state.winId = data.winId; return; }

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
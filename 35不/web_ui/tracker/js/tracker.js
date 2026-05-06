/**
 * tracker.js - 悬浮窗前端逻辑
 * 运行在透明 BrowserWindow 的子窗口 renderer 进程中
 * 通过 Electron IPC（webContents.send）接收主进程的积分更新
 * - 不操作 DOM 之外的任何系统资源
 * - 不发送任何网络请求
 * - 拖拽已迁移至 CSS 原生实现（-webkit-app-region: drag）
 */

// 内部状态
const state = {
    currentPoints: 0,
    totalCost: 0,
    totalRefund: 0,
    taskCount: 0,
    maxRecent: 8,
    // 窗口 ID（由后端 init 事件注入，用于发送控制指令）
    winId: null,
    // 账号总动态开关（默认关闭，不显示他人任务）
    showGlobal: false
};

// DOM 引用
const els = {
    pointsValue: document.getElementById('points-value'),
    pointsDelta: document.getElementById('points-delta'),
    statTasks: document.getElementById('stat-tasks'),
    statCost: document.getElementById('stat-cost'),
    statRefund: document.getElementById('stat-refund'),
    taskList: document.getElementById('task-list'),
};

/**
 * 格式化积分数（每三位加逗号）
 */
function formatNumber(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * 刷新积分数字显示
 */
function updatePointsDisplay(value) {
    els.pointsValue.textContent = formatNumber(value);
}

/**
 * 显示积分变动动画
 * @param {number} delta 正数=返还，负数=消耗
 * @param {'cost'|'refund'|'sync'} type
 */
function showDelta(delta, type) {
    if (delta === 0) return;

    els.pointsDelta.classList.remove('hidden', 'deduct', 'refund', 'sync');
    els.pointsDelta.classList.add(type);

    const sign = delta > 0 ? '+' : '';
    els.pointsDelta.textContent = `${sign}${delta}`;

    // 2 秒后自动淡出
    setTimeout(() => {
        els.pointsDelta.classList.add('hidden');
    }, 2000);
}

/**
 * 更新统计行
 */
function updateStats() {
    els.statTasks.textContent = formatNumber(state.taskCount);
    els.statCost.textContent = formatNumber(state.totalCost);
    els.statRefund.textContent = formatNumber(state.totalRefund);
}

/**
 * 追加最近任务记录
 * - 扣费任务：渲染多行详细卡片（任务类型、计费标识、分辨率、时长、提示词、扣量）
 * - 返还任务：保持简洁单行结构
 * - 他人任务（isAlien）：在标题旁显示黄色"他人生成任务"标签
 * - 本地任务（!isAlien）：在详情区顶部显示请求时间（YYYY-MM-DD HH:mm:ss）
 * @param {Object} task { type: 'cost'|'refund', cost: number, data: Object }
 */
function appendTaskRecord(task) {
    const empty = els.taskList.querySelector('.task-empty');
    if (empty) empty.remove();

    const item = document.createElement('div');
    item.className = 'task-item';

    // 【新增 UI】：判断如果是他人任务，生成专属的 Tag 样式
    const alienTagHtml = task.data.isAlien ?
        `<span style="font-size: 10px; color: #f0b429; background: rgba(240, 180, 41, 0.15); padding: 2px 6px; border-radius: 4px; margin-left: 8px; font-weight: 500; border: 1px solid rgba(240, 180, 41, 0.3);">他人生成任务</span>` : '';

    // 【新增】：格式化本地任务时间，嵌在标题右侧（无标签，纯时间）
    const timeInHeader = (!task.data.isAlien && task.data.timestamp) ? (() => {
        const d = new Date(task.data.timestamp);
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    })() : '';

    if (task.type === 'cost') {
        const taskTypeName = task.data.taskTypeName || '生成任务';
        const taskTypeClass = task.data.taskType || 'image';
        const iconLetter = taskTypeClass === 'video' ? 'V' : taskTypeClass === 'audio' ? 'A' : 'I';

        item.innerHTML = `
            <div class="task-header">
                <div class="task-header-left">
                    <div class="task-icon ${taskTypeClass}">${iconLetter}</div>
                    <span>${taskTypeName}</span>
                    ${alienTagHtml}
                    ${timeInHeader ? `<span style="font-size: 10px; color: #fff; margin-left: 6px;">${timeInHeader}</span>` : ''}
                </div>
                <div class="task-cost negative">-${task.cost} 积分</div>
            </div>
            <div class="task-details-box">
                <div class="detail-row">
                    <span class="detail-label">计费标识</span>
                    <span class="detail-value">${task.data.billingId || '默认'}</span>
                </div>
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
    } else {
        item.innerHTML = `
            <div class="task-header" style="margin-bottom:0;">
                <div class="task-header-left">
                    <div class="task-icon refund">R</div>
                    <span>任务失败返还</span>
                    ${alienTagHtml}
                </div>
                <div class="task-cost positive">+${task.cost} 积分</div>
            </div>
        `;
    }

    els.taskList.insertBefore(item, els.taskList.firstChild);
    while (els.taskList.children.length > state.maxRecent) els.taskList.lastChild.remove();
}

/**
 * 处理来自主进程的积分更新数据
 * @param {Object} data
 *   - type: 'sync' | 'cost' | 'refund'
 *   - currentPoints?: number   // sync 类型时有
 *   - deduct?: number          // cost 类型时有（真实扣量）
 *   - localCost?: number      // cost 类型时有（本地预估扣量）
 *   - refund?: number          // refund 类型时有
 *   - billingId?: string      // 计费标识
 *   - taskType?: string       // 任务类型 'image' | 'video' | 'audio'
 *   - taskTypeName?: string   // 任务中文名
 *   - resolution?: string     // 分辨率
 *   - duration?: number       // 时长（秒）
 *   - prompt?: string         // 提示词摘要
 */
function handlePointsUpdate(data) {
    const { type } = data;

    // 存储后端发来的唯一窗口 ID，用于前端向主进程发送控制指令
    if (type === 'init') {
        state.winId = data.winId;
        return;
    }

    // 核心拦截：如果没开启账号总动态，且该任务是他人任务，直接抛弃
    if (data.isAlien && !state.showGlobal) {
        return;
    }

    if (type === 'sync') {
        // 积分同步：直接更新当前积分
        if (typeof data.currentPoints === 'number') {
            const old = state.currentPoints;
            state.currentPoints = data.currentPoints;
            updatePointsDisplay(data.currentPoints);

            const delta = data.currentPoints - old;
            if (delta !== 0) {
                showDelta(delta, 'sync');
            }
        }
    } else if (type === 'cost') {
        // 【融合点4：消灭双重扣费】不修改 state.currentPoints
        // 积分数字的最终裁判权完全交给 type === 'sync'
        const cost = Math.abs(data.deduct || 0);
        state.totalCost += cost;
        state.taskCount += 1;

        showDelta(-cost, 'cost');
        updateStats();

        // 渲染详细扣费卡片
        appendTaskRecord({
            type: 'cost',
            cost: cost,
            data: {
                taskType: data.taskType,
                taskTypeName: data.taskTypeName,
                billingId: data.billingId,
                resolution: data.resolution,
                duration: data.duration,
                prompt: data.prompt,
                timestamp: data.timestamp,
                isAlien: data.isAlien
            }
        });
    } else if (type === 'refund') {
        // 【融合点4补充：返还同理】不修改 state.currentPoints
        // 积分数字的最终裁判权完全交给 type === 'sync'
        const refund = Math.abs(data.refund || 0);
        state.totalRefund += refund;
        state.taskCount += 1;

        showDelta(refund, 'refund');
        updateStats();

        appendTaskRecord({
            type: 'refund',
            cost: refund,
            data: {
                taskType: data.taskType || '',
                taskTypeName: data.taskTypeName || '任务失败返还',
                isAlien: data.isAlien
            }
        });
    }
}

/**
 * 接收主进程 IPC 推送
 */
function setupIPCReceiver() {
    window.electron.on('tracker:update-points', handlePointsUpdate);
}

// 初始化
function init() {
    setupIPCReceiver();
    updateStats();
    updatePointsDisplay(state.currentPoints);

    // 绑定账号总动态开关事件
    const toggleEl = document.getElementById('toggle-global');
    if (toggleEl) {
        toggleEl.addEventListener('change', (e) => {
            state.showGlobal = e.target.checked;
            if (state.winId !== null) {
                window.electron.send('tracker:toggle-global', {
                    winId: state.winId,
                    state: state.showGlobal
                });
            }
        });
    }
}

document.addEventListener('DOMContentLoaded', init);

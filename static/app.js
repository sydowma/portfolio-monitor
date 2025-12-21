/**
 * OKX 多账户 Dashboard 前端逻辑
 */

const ACCOUNT_KEY_ALL = '__ALL__';

// 状态管理
const state = {
    accounts: [],
    currentAccountId: null, // null 表示显示全部
    balances: {},           // accountId -> balance
    positions: {},          // accountId -> positions[]
    pendingOrders: {},      // accountId -> pendingOrders[]
    wsConnected: false,
    activeTab: 'positions',
    autoRefreshMs: 30 * 1000,
    cache: {
        orders: {},      // accountKey -> { items, hasMore, lastId, fetchedAt, showAccountName }
        bills: {},       // accountKey -> { items, hasMore, lastId, fetchedAt, showAccountName }
        posHistory: {},  // accountKey -> { items, hasMore, lastId, fetchedAt }
        equityCurve: {}, // accountKey -> { data, fetchedAt }  (data is /equity-curve response)
    },
    dataAt: {
        pendingOrders: {}, // accountKey -> last update ms (WS or REST)
    },
    // 订单分页状态
    ordersPagination: {
        page: 1,
        cursors: [null],  // cursors[0]=null(第一页), cursors[1]=第二页的after值...
        hasMore: false,
    },
    // 账单分页状态
    billsPagination: {
        page: 1,
        cursors: [null],
        hasMore: false,
    },
    // 历史仓位分页状态
    posHistoryPagination: {
        page: 1,
        cursors: [null],
        hasMore: false,
    },
    // 资产曲线
    equityChart: null,
    equityCurvePoints: null,
};

// DOM 元素
const elements = {
    wsStatus: document.getElementById('ws-status'),
    wsStatusText: document.getElementById('ws-status-text'),
    totalEquity: document.getElementById('total-equity'),
    totalPnl: document.getElementById('total-pnl'),
    accountList: document.getElementById('account-list'),
    currentAccountName: document.getElementById('current-account-name'),
    accountEquity: document.getElementById('account-equity'),
    accountAvailable: document.getElementById('account-available'),
    accountMargin: document.getElementById('account-margin'),
    accountPnl: document.getElementById('account-pnl'),
    marginRatioBar: document.getElementById('margin-ratio-bar'),
    marginRatioText: document.getElementById('margin-ratio-text'),
    positionsContainer: document.getElementById('positions-container'),
    positionCount: document.getElementById('position-count'),
    noPositions: document.getElementById('no-positions'),
    // 资产
    assetsContainer: document.getElementById('assets-container'),
    assetCount: document.getElementById('asset-count'),
    noAssets: document.getElementById('no-assets'),
    // 在途订单
    pendingOrdersTable: document.getElementById('pending-orders-table'),
    pendingOrderCount: document.getElementById('pending-order-count'),
    noPendingOrders: document.getElementById('no-pending-orders'),
    pendingOrdersLoading: document.getElementById('pending-orders-loading'),
    // 订单
    ordersTable: document.getElementById('orders-table'),
    noOrders: document.getElementById('no-orders'),
    ordersLoading: document.getElementById('orders-loading'),
    // 账单
    billsTable: document.getElementById('bills-table'),
    noBills: document.getElementById('no-bills'),
    billsLoading: document.getElementById('bills-loading'),
    billSummary: document.getElementById('bill-summary'),
    // 分页控件
    ordersPagination: document.getElementById('orders-pagination'),
    ordersPrevBtn: document.getElementById('orders-prev-btn'),
    ordersNextBtn: document.getElementById('orders-next-btn'),
    ordersPageInfo: document.getElementById('orders-page-info'),
    billsPagination: document.getElementById('bills-pagination'),
    billsPrevBtn: document.getElementById('bills-prev-btn'),
    billsNextBtn: document.getElementById('bills-next-btn'),
    billsPageInfo: document.getElementById('bills-page-info'),
    // 历史仓位
    posHistoryContainer: document.getElementById('pos-history-container'),
    noPosHistory: document.getElementById('no-pos-history'),
    posHistoryLoading: document.getElementById('pos-history-loading'),
    posHistoryPagination: document.getElementById('pos-history-pagination'),
    posHistoryPrevBtn: document.getElementById('pos-history-prev-btn'),
    posHistoryNextBtn: document.getElementById('pos-history-next-btn'),
    posHistoryPageInfo: document.getElementById('pos-history-page-info'),
    // 主题切换
    themeToggle: document.getElementById('theme-toggle'),
};

// ========== Theme ==========

const THEME_STORAGE_KEY = 'pm-theme';

function normalizeTheme(theme) {
    return theme === 'light' ? 'light' : 'dark';
}

function getCssVarTriplet(varName) {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
    if (!raw) return null;
    const parts = raw.split(/\s+/).map((v) => Number(v)).filter((n) => !Number.isNaN(n));
    return parts.length === 3 ? parts : null;
}

function rgbaFromTriplet(triplet, alpha) {
    const [r, g, b] = triplet;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function cssRgba(varName, alpha) {
    const t = getCssVarTriplet(varName);
    return t ? rgbaFromTriplet(t, alpha) : `rgba(255, 255, 255, ${alpha})`;
}

function refreshThemeSensitiveUI() {
    // Chart.js 颜色是 JS 配置的：主题切换时需要重绘
    if (state.equityChart && Array.isArray(state.equityCurvePoints) && state.equityCurvePoints.length > 0) {
        renderEquityChart(state.equityCurvePoints);
    }
}

function getTheme() {
    const t = document.documentElement.dataset.theme;
    return t === 'light' || t === 'dark' ? t : 'dark';
}

function applyTheme(theme, persist = true) {
    const t = normalizeTheme(theme);
    document.documentElement.dataset.theme = t;
    if (persist) {
        try { localStorage.setItem(THEME_STORAGE_KEY, t); } catch (_) {}
    }
    updateThemeToggleAria(t);
    refreshThemeSensitiveUI();
}

function updateThemeToggleAria(theme) {
    const root = elements.themeToggle;
    if (!root) return;
    const btns = root.querySelectorAll('[data-theme-value]');
    btns.forEach((btn) => {
        const isActive = btn.dataset.themeValue === theme;
        btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
}

function setupThemeToggle() {
    if (!elements.themeToggle) return;

    // 同步 aria 状态（主题在 <head> 里已预加载）
    updateThemeToggleAria(getTheme());
    
    // 强制同步一次主题，确保 Chart.js 等组件获取到最新的 CSS 变量
    applyTheme(getTheme(), false);

    elements.themeToggle.addEventListener('click', (event) => {
        const btn = event.target.closest('button[data-theme-value]');
        if (!btn) return;
        applyTheme(btn.dataset.themeValue, true);
    });
}

// WebSocket 连接
let ws = null;
let wsPingTimer = null;
let wsReconnectTimer = null;

function nowMs() {
    return Date.now();
}

function getAccountKey() {
    return state.currentAccountId === null ? ACCOUNT_KEY_ALL : state.currentAccountId;
}

function isStale(tsMs) {
    if (!tsMs) return true;
    return nowMs() - tsMs > state.autoRefreshMs;
}

/**
 * 初始化应用
 */
async function init() {
    await loadAccounts();
    connectWebSocket();
    await loadInitialData();

    // 设置默认时间范围（最近7天）
    const now = new Date();
    const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);
    document.getElementById('order-start').value = formatDateTimeLocal(weekAgo);
    document.getElementById('order-end').value = formatDateTimeLocal(now);
    document.getElementById('bill-start').value = formatDateTimeLocal(weekAgo);
    document.getElementById('bill-end').value = formatDateTimeLocal(now);
    // 历史仓位默认查询最近30天
    document.getElementById('pos-history-start').value = formatDateTimeLocal(monthAgo);
    document.getElementById('pos-history-end').value = formatDateTimeLocal(now);
}

/**
 * 加载账户列表
 */
async function loadAccounts() {
    try {
        const resp = await fetch('/api/accounts');
        state.accounts = await resp.json();
        renderAccountList();
    } catch (err) {
        console.error('Failed to load accounts:', err);
    }
}

/**
 * 加载初始数据（所有账户的资产和仓位）
 */
async function loadInitialData() {
    try {
        const resp = await fetch('/api/summary');
        const summaries = await resp.json();

        for (const summary of summaries) {
            if (summary.balance) {
                state.balances[summary.account.id] = summary.balance;
            }
            if (summary.positions) {
                state.positions[summary.account.id] = summary.positions;
            }
        }

        updateTotalSummary();
        renderCurrentView();
    } catch (err) {
        console.error('Failed to load initial data:', err);
    }
}

/**
 * 连接 WebSocket
 */
function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    // 清理旧连接与定时器，避免重连后叠加心跳
    if (ws) {
        try { ws.close(); } catch (_) {}
        ws = null;
    }
    if (wsPingTimer) {
        clearInterval(wsPingTimer);
        wsPingTimer = null;
    }
    if (wsReconnectTimer) {
        clearTimeout(wsReconnectTimer);
        wsReconnectTimer = null;
    }

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        state.wsConnected = true;
        updateWsStatus(true);
        console.log('WebSocket connected');
    };

    ws.onclose = () => {
        state.wsConnected = false;
        updateWsStatus(false);
        console.log('WebSocket disconnected, reconnecting...');
        if (wsPingTimer) {
            clearInterval(wsPingTimer);
            wsPingTimer = null;
        }
        wsReconnectTimer = setTimeout(connectWebSocket, 3000);
    };

    ws.onerror = (err) => {
        console.error('WebSocket error:', err);
    };

    ws.onmessage = (event) => {
        // 后端可能返回心跳响应
        if (event.data === 'pong') return;
        try {
            const msg = JSON.parse(event.data);
            handleWsMessage(msg);
        } catch (err) {
            console.error('Failed to parse WS message:', err);
        }
    };

    // 心跳
    wsPingTimer = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send('ping');
        }
    }, 30000);
}

/**
 * 处理 WebSocket 消息
 */
function handleWsMessage(msg) {
    switch (msg.type) {
        case 'balance':
            state.balances[msg.account_id] = msg.data;
            updateTotalSummary();
            if (state.currentAccountId === null || state.currentAccountId === msg.account_id) {
                renderBalanceCard();
            }
            // 如果当前在资产页，资产需要跟随 balance 的 assets 刷新
            if (state.activeTab === 'assets' && (state.currentAccountId === null || state.currentAccountId === msg.account_id)) {
                renderAssetsTable();
            }
            break;

        case 'positions':
            state.positions[msg.account_id] = msg.data;
            if (state.currentAccountId === null || state.currentAccountId === msg.account_id) {
                renderPositionsTable();
            }
            break;

        case 'pending_orders':
            state.pendingOrders[msg.account_id] = msg.data;
            // 记录更新时间：单账户 + 全部账户都更新一下，供 TTL 判断
            state.dataAt.pendingOrders[msg.account_id] = nowMs();
            state.dataAt.pendingOrders[ACCOUNT_KEY_ALL] = nowMs();

            if (state.activeTab === 'pending-orders' && (state.currentAccountId === null || state.currentAccountId === msg.account_id)) {
                renderPendingOrdersTable();
            }
            break;

        case 'error':
            console.error(`Account ${msg.account_id} error:`, msg.message);
            break;
    }
}

/**
 * 更新 WebSocket 状态显示
 */
function updateWsStatus(connected) {
    if (connected) {
        elements.wsStatus.className = 'w-2 h-2 rounded-full bg-profit pulse-dot';
        elements.wsStatusText.textContent = '实时连接';
    } else {
        elements.wsStatus.className = 'w-2 h-2 rounded-full bg-loss pulse-dot';
        elements.wsStatusText.textContent = '连接断开';
    }
}

/**
 * 渲染账户列表
 */
function renderAccountList() {
    let html = `
        <button type="button" data-account-id="${ACCOUNT_KEY_ALL}" onclick="selectAccount(null)" class="account-btn group relative w-full text-left px-4 py-3 rounded-xl text-sm transition-all ${state.currentAccountId === null ? 'bg-accent text-white' : 'hover:bg-glass-hover text-text-primary'}">
            ${state.currentAccountId === null ? '<div class="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-8 bg-white rounded-r-full"></div>' : ''}
            <div class="flex items-center justify-between">
                <span class="flex items-center gap-2">
                    <span class="text-base group-hover:scale-110 transition-transform">📊</span>
                    <span class="font-medium">全部账户</span>
                </span>
                <span class="text-xs ${state.currentAccountId === null ? 'text-white/70' : 'text-text-muted'} px-2 py-0.5 ${state.currentAccountId === null ? 'bg-white/20' : 'bg-app-elevated'} rounded-full">${state.accounts.length}</span>
            </div>
        </button>
    `;

    for (const account of state.accounts) {
        const isActive = state.currentAccountId === account.id;
        const balance = state.balances[account.id];
        const equity = balance ? formatNumber(balance.total_equity) : '--';
        const pnl = balance ? balance.unrealized_pnl : 0;
        const pnlClass = pnl >= 0 ? 'text-profit' : 'text-loss';

        html += `
            <button type="button" data-account-id="${account.id}" onclick="selectAccount('${account.id}')" class="account-btn group relative w-full text-left px-4 py-3 rounded-xl text-sm transition-all ${isActive ? 'bg-accent text-white' : 'hover:bg-glass-hover text-text-primary'}">
                ${isActive ? '<div class="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-8 bg-white rounded-r-full"></div>' : ''}
                <div class="flex items-center justify-between">
                    <div class="flex items-center gap-2">
                        <span class="text-base group-hover:scale-110 transition-transform">${account.simulated ? '🎮' : '💰'}</span>
                        <span class="font-medium">${account.name}</span>
                    </div>
                    ${account.simulated ? '<span class="text-xs px-1.5 py-0.5 rounded bg-warning/20 text-warning">模拟</span>' : ''}
                </div>
                <div class="flex items-center justify-between mt-1.5 ml-6">
                    <span data-role="account-equity" class="text-xs ${isActive ? 'text-white/70' : 'text-text-muted'} font-mono">$${equity}</span>
                    <span data-role="account-pnl" class="text-xs font-mono ${balance && pnl !== 0 ? (isActive ? 'text-white/70' : pnlClass) : 'hidden'}">
                        ${balance && pnl !== 0 ? `${pnl >= 0 ? '+' : ''}${formatNumber(pnl)}` : ''}
                    </span>
                </div>
            </button>
        `;
    }

    elements.accountList.innerHTML = html;
}

function updateAccountListMetrics() {
    if (!elements.accountList) return;

    // 只更新数值文本与少量 class，避免频繁重建 DOM 导致“点击失效”
    const buttons = elements.accountList.querySelectorAll('button[data-account-id]');
    for (const btn of buttons) {
        const accountId = btn.dataset.accountId;
        if (!accountId || accountId === ACCOUNT_KEY_ALL) continue;

        const isActive = state.currentAccountId === accountId;
        const balance = state.balances[accountId];

        const equitySpan = btn.querySelector('[data-role="account-equity"]');
        if (equitySpan) {
            const equityText = balance ? formatNumber(balance.total_equity) : '--';
            equitySpan.textContent = '$' + equityText;
            equitySpan.className = `text-xs ${isActive ? 'text-white/70' : 'text-text-muted'} font-mono`;
        }

        const pnlSpan = btn.querySelector('[data-role="account-pnl"]');
        if (pnlSpan) {
            const pnl = balance ? (balance.unrealized_pnl || 0) : 0;
            const show = !!balance && pnl !== 0;
            pnlSpan.textContent = show ? ((pnl >= 0 ? '+' : '') + formatNumber(pnl)) : '';
            pnlSpan.className = `text-xs font-mono ${show ? (isActive ? 'text-white/70' : (pnl >= 0 ? 'text-profit' : 'text-loss')) : 'hidden'}`;
        }
    }
}

/**
 * 选择账户
 */
function selectAccount(accountId) {
    state.currentAccountId = accountId;
    renderAccountList();
    renderCurrentView();

    if (accountId === null) {
        elements.currentAccountName.textContent = '全部账户';
    } else {
        const account = state.accounts.find(a => a.id === accountId);
        elements.currentAccountName.textContent = account ? account.name : '';
    }

    // 账号切换后：让当前 tab 自己决定是否需要重新请求（基于 TTL=30s / 缓存）
    onTabActivated(state.activeTab, { reason: 'account-change' });
}

/**
 * 获取当前激活的 tab
 */
function getCurrentTab() {
    if (state.activeTab) return state.activeTab;
    if (!document.getElementById('view-positions').classList.contains('hidden')) {
        return 'positions';
    } else if (!document.getElementById('view-assets').classList.contains('hidden')) {
        return 'assets';
    } else if (!document.getElementById('view-pending-orders').classList.contains('hidden')) {
        return 'pending-orders';
    } else if (!document.getElementById('view-orders').classList.contains('hidden')) {
        return 'orders';
    } else if (!document.getElementById('view-bills').classList.contains('hidden')) {
        return 'bills';
    } else if (!document.getElementById('view-position-history').classList.contains('hidden')) {
        return 'position-history';
    } else if (!document.getElementById('view-equity-curve').classList.contains('hidden')) {
        return 'equity-curve';
    }
    return 'positions';
}

/**
 * 更新汇总信息
 */
function updateTotalSummary() {
    let totalEquity = 0;
    let totalPnl = 0;

    for (const accountId in state.balances) {
        const balance = state.balances[accountId];
        totalEquity += balance.total_equity || 0;
        totalPnl += balance.unrealized_pnl || 0;
    }

    elements.totalEquity.textContent = '$' + formatNumber(totalEquity);

    const pnlText = (totalPnl >= 0 ? '+' : '') + formatNumber(totalPnl);
    elements.totalPnl.textContent = '$' + pnlText;
    elements.totalPnl.className = `text-sm font-mono font-medium ${totalPnl >= 0 ? 'text-profit' : 'text-loss'}`;

    // 同时更新账户列表中的权益显示（避免频繁重建 DOM）
    updateAccountListMetrics();
}

/**
 * 渲染当前视图
 */
function renderCurrentView() {
    renderBalanceCard();
    renderPositionsTable();
}

/**
 * 渲染资产卡片
 */
function renderBalanceCard() {
    let totalEquity = 0;
    let totalAvailable = 0;
    let totalMargin = 0;
    let totalPnl = 0;

    if (state.currentAccountId === null) {
        // 显示汇总
        for (const accountId in state.balances) {
            const balance = state.balances[accountId];
            totalEquity += balance.total_equity || 0;
            totalAvailable += balance.available || 0;
            totalMargin += balance.margin_used || 0;
            totalPnl += balance.unrealized_pnl || 0;
        }
    } else {
        const balance = state.balances[state.currentAccountId];
        if (balance) {
            totalEquity = balance.total_equity || 0;
            totalAvailable = balance.available || 0;
            totalMargin = balance.margin_used || 0;
            totalPnl = balance.unrealized_pnl || 0;
        }
    }

    // 更新显示
    if (totalEquity > 0 || state.currentAccountId !== null) {
        elements.accountEquity.textContent = '$' + formatNumber(totalEquity);
        elements.accountAvailable.textContent = '$' + formatNumber(totalAvailable);
        elements.accountMargin.textContent = '$' + formatNumber(totalMargin);

        const pnlText = (totalPnl >= 0 ? '+' : '') + formatNumber(totalPnl);
        elements.accountPnl.textContent = '$' + pnlText;
        elements.accountPnl.className = `text-2xl font-mono font-semibold ${totalPnl >= 0 ? 'text-profit glow-profit' : 'text-loss glow-loss'}`;

        // 计算保证金使用率
        const marginRatio = totalEquity > 0 ? (totalMargin / totalEquity) * 100 : 0;
        elements.marginRatioBar.style.width = `${Math.min(marginRatio, 100)}%`;
        elements.marginRatioText.textContent = `${marginRatio.toFixed(1)}%`;
        
        // 根据使用率变色
        if (marginRatio > 80) {
            elements.marginRatioBar.className = 'h-full bg-loss rounded-full transition-all';
        } else if (marginRatio > 50) {
            elements.marginRatioBar.className = 'h-full bg-warning rounded-full transition-all';
        } else {
            elements.marginRatioBar.className = 'h-full bg-accent rounded-full transition-all';
        }
    } else {
        elements.accountEquity.textContent = '--';
        elements.accountAvailable.textContent = '--';
        elements.accountMargin.textContent = '--';
        elements.accountPnl.textContent = '--';
        elements.accountPnl.className = 'text-2xl font-mono font-semibold';
        elements.marginRatioBar.style.width = '0%';
        elements.marginRatioText.textContent = '0%';
    }
}

/**
 * 渲染仓位卡片
 */
function renderPositionsTable() {
    let positions = [];

    if (state.currentAccountId === null) {
        // 合并所有账户的仓位
        for (const accountId in state.positions) {
            const account = state.accounts.find(a => a.id === accountId);
            const accountName = account ? account.name : accountId;

            for (const pos of state.positions[accountId]) {
                positions.push({ ...pos, accountName });
            }
        }
    } else {
        // 单账户模式下也添加账户名称
        const account = state.accounts.find(a => a.id === state.currentAccountId);
        const accountName = account ? account.name : state.currentAccountId;
        positions = (state.positions[state.currentAccountId] || []).map(pos => ({
            ...pos,
            accountName
        }));
    }

    elements.positionCount.textContent = `${positions.length} 个仓位`;

    if (positions.length === 0) {
        elements.positionsContainer.innerHTML = '';
        elements.noPositions.classList.remove('hidden');
        return;
    }

    elements.noPositions.classList.add('hidden');

    let html = '';
    for (const pos of positions) {
        const isLong = pos.pos_side === 'long' || (pos.pos_side === 'net' && pos.pos > 0);
        const directionText = isLong ? '多' : '空';
        const directionClass = isLong ? 'text-profit' : 'text-loss';
        const directionBgClass = isLong ? 'bg-profit/20' : 'bg-loss/20';
        const borderClass = isLong ? 'border-profit/30' : 'border-loss/30';

        const uplText = (pos.upl >= 0 ? '+' : '') + formatNumber(pos.upl);
        const uplClass = pos.upl >= 0 ? 'text-profit' : 'text-loss';
        const uplGlow = pos.upl >= 0 ? 'glow-profit' : 'glow-loss';

        const uplRatioText = (pos.upl_ratio >= 0 ? '+' : '') + (pos.upl_ratio * 100).toFixed(2) + '%';
        const uplRatioClass = pos.upl_ratio >= 0 ? 'text-profit' : 'text-loss';

        // 收益率进度条 (限制在 -100% 到 100% 范围)
        const progressPercent = Math.min(Math.abs(pos.upl_ratio * 100), 100);
        const progressColor = pos.upl_ratio >= 0 ? 'bg-profit' : 'bg-loss';

        // 强平价显示
        const liqPxText = pos.liq_px ? formatPrice(pos.liq_px) : '--';

        html += `
            <div class="position-card relative bg-app-elevated rounded-xl p-4 border ${borderClass} hover:bg-app-surface transition-all">
                <!-- 悬浮详情按钮 -->
                <div class="absolute top-2 right-2">
                    ${detailBtnHtml('position', pos)}
                </div>
                <!-- 头部：合约名 + 方向 + 杠杆 -->
                <div class="flex items-center justify-between mb-3 pr-12">
                    <div class="flex items-center gap-2">
                        <span class="font-mono text-sm font-semibold text-text-primary">${pos.inst_id}</span>
                        <span class="px-2 py-0.5 rounded text-xs font-semibold ${directionClass} ${directionBgClass}">
                            ${directionText}
                        </span>
                    </div>
                    <span class="text-xs text-text-muted font-mono">${pos.lever}x</span>
                </div>

                <!-- 账户名称 + 开仓时间 -->
                <div class="flex justify-between text-xs text-text-muted mb-3">
                    <span>${pos.accountName}</span>
                    <span>${formatOpenTime(pos.created_at)}</span>
                </div>

                <!-- 核心数据 -->
                <div class="grid grid-cols-2 gap-x-4 gap-y-2 mb-3 text-xs">
                    <div class="flex justify-between">
                        <span class="text-text-muted">持仓</span>
                        <span class="font-mono text-text-secondary">${Math.abs(pos.pos)}</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-text-muted">开仓价</span>
                        <span class="font-mono text-text-secondary">${formatPrice(pos.avg_px)}</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-text-muted">标记价</span>
                        <span class="font-mono text-text-primary">${formatPrice(pos.mark_px)}</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-text-muted">强平价</span>
                        <span class="font-mono text-loss/80">${liqPxText}</span>
                    </div>
                </div>

                <!-- 盈亏区域 -->
                <div class="pt-3 border-t border-app-separator">
                    <div class="flex items-baseline justify-between mb-2">
                        <span class="text-3xl font-mono font-bold ${uplClass} ${uplGlow}">$${uplText}</span>
                        <span class="text-sm font-mono font-semibold ${uplRatioClass}">${uplRatioText}</span>
                    </div>
                    <!-- 收益率进度条 -->
                    <div class="h-1.5 bg-app-surface rounded-full overflow-hidden">
                        <div class="h-full ${progressColor} rounded-full transition-all" style="width: ${progressPercent}%"></div>
                    </div>
                </div>
            </div>
        `;
    }

    elements.positionsContainer.innerHTML = html;
}

/**
 * 渲染资产卡片
 */
function renderAssetsTable() {
    let assets = [];

    if (state.currentAccountId === null) {
        // 合并所有账户的资产
        const assetMap = {};  // ccy -> { bal, avail_bal, frozen_bal, eq }
        
        for (const accountId in state.balances) {
            const balance = state.balances[accountId];
            if (balance.assets) {
                for (const asset of balance.assets) {
                    if (!assetMap[asset.ccy]) {
                        assetMap[asset.ccy] = {
                            ccy: asset.ccy,
                            bal: 0,
                            avail_bal: 0,
                            frozen_bal: 0,
                            eq: 0,
                        };
                    }
                    assetMap[asset.ccy].bal += asset.bal;
                    assetMap[asset.ccy].avail_bal += asset.avail_bal;
                    assetMap[asset.ccy].frozen_bal += asset.frozen_bal;
                    assetMap[asset.ccy].eq += asset.eq;
                }
            }
        }
        
        assets = Object.values(assetMap);
        // 按权益排序
        assets.sort((a, b) => b.eq - a.eq);
    } else {
        const balance = state.balances[state.currentAccountId];
        if (balance && balance.assets) {
            assets = balance.assets;
        }
    }

    elements.assetCount.textContent = `${assets.length} 个币种`;

    if (assets.length === 0) {
        elements.assetsContainer.innerHTML = '';
        elements.noAssets.classList.remove('hidden');
        return;
    }

    elements.noAssets.classList.add('hidden');

    let html = '';
    for (const asset of assets) {
        const iconUrl = getCryptoIconUrl(asset.ccy);
        const fallbackText = asset.ccy.slice(0, 2);
        
        // 计算可用比例
        const availRatio = asset.bal > 0 ? (asset.avail_bal / asset.bal) * 100 : 100;
        
        html += `
            <div class="asset-card relative bg-app-elevated rounded-xl p-4 hover:bg-app-surface transition-all border border-transparent hover:border-accent/20">
                <!-- 悬浮详情按钮 -->
                <div class="absolute top-2 right-2">
                    ${detailBtnHtml('asset', asset)}
                </div>
                <!-- 头部：币种图标 + 名称 + 估值 -->
                <div class="flex items-center justify-between mb-3 pr-10">
                    <div class="flex items-center gap-3">
                        <div class="w-10 h-10 rounded-full bg-app-surface flex items-center justify-center overflow-hidden">
                            <img src="${iconUrl}" 
                                 alt="${asset.ccy}" 
                                 class="w-7 h-7"
                                 onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';"
                            />
                            <span class="text-sm font-bold hidden items-center justify-center w-full h-full text-accent">${fallbackText}</span>
                        </div>
                        <div>
                            <div class="font-semibold text-text-primary">${asset.ccy}</div>
                            <div class="text-xs text-text-muted">估值</div>
                        </div>
                    </div>
                    <div class="text-right">
                        <div class="text-xl font-mono font-bold text-text-primary">$${formatNumber(asset.eq)}</div>
                    </div>
                </div>

                <!-- 余额详情 -->
                <div class="space-y-2 text-xs">
                    <div class="flex justify-between items-center">
                        <span class="text-text-muted">总余额</span>
                        <span class="font-mono text-text-secondary">${formatAssetNumber(asset.bal)}</span>
                    </div>
                    <div class="flex justify-between items-center">
                        <span class="text-text-muted">可用</span>
                        <span class="font-mono text-profit">${formatAssetNumber(asset.avail_bal)}</span>
                    </div>
                    ${asset.frozen_bal > 0 ? `
                    <div class="flex justify-between items-center">
                        <span class="text-text-muted">冻结</span>
                        <span class="font-mono text-loss/70">${formatAssetNumber(asset.frozen_bal)}</span>
                    </div>
                    ` : ''}
                </div>

                <!-- 可用比例进度条 -->
                <div class="mt-3 pt-3 border-t border-app-separator">
                    <div class="flex justify-between items-center text-xs mb-1.5">
                        <span class="text-text-muted">可用比例</span>
                        <span class="font-mono text-text-secondary">${availRatio.toFixed(1)}%</span>
                    </div>
                    <div class="h-1.5 bg-app-surface rounded-full overflow-hidden">
                        <div class="h-full bg-accent rounded-full transition-all" style="width: ${availRatio}%"></div>
                    </div>
                </div>
            </div>
        `;
    }

    elements.assetsContainer.innerHTML = html;
}

/**
 * 获取加密货币图标 URL
 * 使用 OKX 官方图标，保证所有 OKX 支持的币种都有图标
 */
function getCryptoIconUrl(symbol) {
    // OKX 官方图标 CDN
    return `https://static.okx.com/cdn/oksupport/asset/currency/icon/${symbol.toLowerCase()}.png`;
}

/**
 * 切换标签页
 */
function switchTab(tab) {
    state.activeTab = tab;
    const viewPositions = document.getElementById('view-positions');
    const viewAssets = document.getElementById('view-assets');
    const viewPendingOrders = document.getElementById('view-pending-orders');
    const viewOrders = document.getElementById('view-orders');
    const viewBills = document.getElementById('view-bills');
    const viewPositionHistory = document.getElementById('view-position-history');
    const viewEquityCurve = document.getElementById('view-equity-curve');
    const tabPositions = document.getElementById('tab-positions');
    const tabAssets = document.getElementById('tab-assets');
    const tabPendingOrders = document.getElementById('tab-pending-orders');
    const tabOrders = document.getElementById('tab-orders');
    const tabBills = document.getElementById('tab-bills');
    const tabPositionHistory = document.getElementById('tab-position-history');
    const tabEquityCurve = document.getElementById('tab-equity-curve');

    const inactiveClass = 'tab-btn px-5 py-2 rounded-lg text-sm font-medium text-text-muted hover:text-text-primary hover:bg-glass-hover transition-all';
    const activeClass = 'tab-btn px-5 py-2 rounded-lg text-sm font-medium tab-active transition-all';

    // 隐藏所有视图，重置所有标签
    viewPositions.classList.add('hidden');
    viewAssets.classList.add('hidden');
    viewPendingOrders.classList.add('hidden');
    viewOrders.classList.add('hidden');
    viewBills.classList.add('hidden');
    viewPositionHistory.classList.add('hidden');
    viewEquityCurve.classList.add('hidden');
    tabPositions.className = inactiveClass;
    tabAssets.className = inactiveClass;
    tabPendingOrders.className = inactiveClass;
    tabOrders.className = inactiveClass;
    tabBills.className = inactiveClass;
    tabPositionHistory.className = inactiveClass;
    tabEquityCurve.className = inactiveClass;

    if (tab === 'positions') {
        viewPositions.classList.remove('hidden');
        tabPositions.className = activeClass;
    } else if (tab === 'assets') {
        viewAssets.classList.remove('hidden');
        tabAssets.className = activeClass;
    } else if (tab === 'pending-orders') {
        viewPendingOrders.classList.remove('hidden');
        tabPendingOrders.className = activeClass;
    } else if (tab === 'orders') {
        viewOrders.classList.remove('hidden');
        tabOrders.className = activeClass;
    } else if (tab === 'bills') {
        viewBills.classList.remove('hidden');
        tabBills.className = activeClass;
    } else if (tab === 'position-history') {
        viewPositionHistory.classList.remove('hidden');
        tabPositionHistory.className = activeClass;
    } else if (tab === 'equity-curve') {
        viewEquityCurve.classList.remove('hidden');
        tabEquityCurve.className = activeClass;
    }

    onTabActivated(tab, { reason: 'tab-switch' });
}

function resetOrdersToFirstPage() {
    state.ordersPagination = { page: 1, cursors: [null], hasMore: false };
    elements.ordersPagination.classList.add('hidden');
}

function resetBillsToFirstPage() {
    state.billsPagination = { page: 1, cursors: [null], hasMore: false };
    elements.billsPagination.classList.add('hidden');
}

function resetPosHistoryToFirstPage() {
    state.posHistoryPagination = { page: 1, cursors: [null], hasMore: false };
    elements.posHistoryPagination.classList.add('hidden');
}

function applyOrdersCache(cache) {
    if (!cache) return false;
    resetOrdersToFirstPage();

    renderOrdersTable(cache.items || [], cache.showAccountName);
    if (state.currentAccountId === null) {
        elements.ordersPagination.classList.add('hidden');
        return true;
    }
    state.ordersPagination.hasMore = !!cache.hasMore;
    if (cache.hasMore && cache.lastId) {
        state.ordersPagination.cursors[1] = cache.lastId;
    }
    updateOrdersPagination();
    return true;
}

function applyBillsCache(cache) {
    if (!cache) return false;
    resetBillsToFirstPage();

    renderBillsTable(cache.items || [], cache.showAccountName);
    if (state.currentAccountId === null) {
        elements.billsPagination.classList.add('hidden');
        return true;
    }
    state.billsPagination.hasMore = !!cache.hasMore;
    if (cache.hasMore && cache.lastId) {
        state.billsPagination.cursors[1] = cache.lastId;
    }
    updateBillsPagination();
    return true;
}

function applyPosHistoryCache(cache) {
    if (!cache) return false;
    resetPosHistoryToFirstPage();

    renderPositionHistoryCards(cache.items || []);
    state.posHistoryPagination.hasMore = !!cache.hasMore;
    if (cache.hasMore && cache.lastId) {
        state.posHistoryPagination.cursors[1] = cache.lastId;
    }
    updatePosHistoryPagination();
    return true;
}

function applyEquityCurveCache(cache) {
    if (!cache || !cache.data) return false;
    const data = cache.data;
    const points = Array.isArray(data.points) ? data.points : [];

    // 兼容后端返回：points 为空也算有效缓存（无需重复请求）
    if (!points.length) {
        const noDataEl = document.getElementById('no-equity-data');
        noDataEl.classList.remove('hidden');
        if (state.equityChart) {
            state.equityChart.destroy();
            state.equityChart = null;
        }
        state.equityCurvePoints = null;
        document.getElementById('equity-start').textContent = '--';
        document.getElementById('equity-end').textContent = '--';
        document.getElementById('equity-change').textContent = '--';
        document.getElementById('equity-points').textContent = '--';
        return true;
    }

    // 更新汇总信息
    const startBal = data.start_balance || 0;
    const endBal = data.end_balance || 0;
    const change = endBal - startBal;
    const changePercent = startBal > 0 ? ((change / startBal) * 100).toFixed(2) : 0;

    document.getElementById('equity-start').textContent = '$' + formatNumber(startBal);
    document.getElementById('equity-end').textContent = '$' + formatNumber(endBal);

    const changeText = (change >= 0 ? '+' : '') + formatNumber(change) + ` (${change >= 0 ? '+' : ''}${changePercent}%)`;
    const changeEl = document.getElementById('equity-change');
    changeEl.textContent = changeText;
    changeEl.className = `text-xl font-mono font-semibold ${change >= 0 ? 'text-profit' : 'text-loss'}`;
    document.getElementById('equity-points').textContent = data.total_points || points.length;

    // 渲染图表
    state.equityCurvePoints = points;
    renderEquityChart(points);
    document.getElementById('no-equity-data').classList.add('hidden');
    return true;
}

function shouldAutoFetchPendingOrders() {
    const key = getAccountKey();
    const lastAt = state.dataAt.pendingOrders[key] || 0;
    const hasSnapshot =
        key === ACCOUNT_KEY_ALL
            ? state.accounts.some((a) => state.pendingOrders[a.id] !== undefined)
            : state.pendingOrders[key] !== undefined;
    return !hasSnapshot || isStale(lastAt);
}

function onTabActivated(tab, { reason } = {}) {
    // 统一：回到第 1 页（且尽量先用缓存/现有 state 立即渲染）
    if (tab === 'positions') {
        renderCurrentView();
        return;
    }
    if (tab === 'assets') {
        renderAssetsTable();
        return;
    }
    if (tab === 'pending-orders') {
        // 始终先渲染一次（解决：离开 tab 期间 WS 更新导致的 UI 不刷新）
        renderPendingOrdersTable();
        if (shouldAutoFetchPendingOrders()) {
            loadPendingOrders({ preserveExisting: true, reason: reason || 'auto' });
        }
        return;
    }
    if (tab === 'orders') {
        resetOrdersToFirstPage();
        const key = getAccountKey();
        const cache = state.cache.orders[key];
        if (cache) applyOrdersCache(cache);
        if (!cache || isStale(cache.fetchedAt)) {
            loadOrders(true, { preserveExisting: !!cache, reason: reason || 'auto' });
        }
        return;
    }
    if (tab === 'bills') {
        resetBillsToFirstPage();
        const key = getAccountKey();
        const cache = state.cache.bills[key];
        if (cache) applyBillsCache(cache);
        if (!cache || isStale(cache.fetchedAt)) {
            loadBills(true, { preserveExisting: !!cache, reason: reason || 'auto' });
        }
        return;
    }
    if (tab === 'position-history') {
        resetPosHistoryToFirstPage();
        // 该 tab 仅支持单账户
        if (state.currentAccountId === null) {
            loadPositionHistory(true, { preserveExisting: false, reason: reason || 'auto' });
            return;
        }
        const key = getAccountKey();
        const cache = state.cache.posHistory[key];
        if (cache) applyPosHistoryCache(cache);
        if (!cache || isStale(cache.fetchedAt)) {
            loadPositionHistory(true, { preserveExisting: !!cache, reason: reason || 'auto' });
        }
        return;
    }
    if (tab === 'equity-curve') {
        // 该 tab 仅支持单账户
        if (state.currentAccountId === null) {
            loadEquityCurve({ preserveExisting: false, reason: reason || 'auto' });
            return;
        }
        const key = getAccountKey();
        const cache = state.cache.equityCurve[key];
        if (cache) applyEquityCurveCache(cache);
        if (!cache || isStale(cache.fetchedAt)) {
            loadEquityCurve({ preserveExisting: !!cache, reason: reason || 'auto' });
        }
        return;
    }
}

/**
 * 加载在途订单
 */
async function loadPendingOrders(options = {}) {
    const { preserveExisting = false } = options || {};

    elements.pendingOrdersLoading.classList.remove('hidden');
    elements.noPendingOrders.classList.add('hidden');
    if (!preserveExisting) {
        elements.pendingOrdersTable.innerHTML = '';
    }

    try {
        if (state.currentAccountId === null) {
            // 全部账户模式：加载所有账户的在途订单
            await loadAllAccountsPendingOrders();
            state.dataAt.pendingOrders[ACCOUNT_KEY_ALL] = nowMs();
        } else {
            // 单账户模式
            const resp = await fetch(`/api/accounts/${state.currentAccountId}/pending-orders`);
            const orders = await resp.json();
            state.pendingOrders[state.currentAccountId] = orders;
            state.dataAt.pendingOrders[state.currentAccountId] = nowMs();
            state.dataAt.pendingOrders[ACCOUNT_KEY_ALL] = nowMs();
            renderPendingOrdersTable();
        }
    } catch (err) {
        console.error('Failed to load pending orders:', err);
        elements.pendingOrdersTable.innerHTML = `<tr><td colspan="10" class="px-6 py-4 text-center text-loss">加载失败: ${err.message}</td></tr>`;
    } finally {
        elements.pendingOrdersLoading.classList.add('hidden');
    }
}

/**
 * 加载所有账户的在途订单
 */
async function loadAllAccountsPendingOrders() {
    for (const account of state.accounts) {
        try {
            const resp = await fetch(`/api/accounts/${account.id}/pending-orders`);
            const orders = await resp.json();
            state.pendingOrders[account.id] = orders;
            state.dataAt.pendingOrders[account.id] = nowMs();
        } catch (err) {
            console.error(`Failed to load pending orders for ${account.name}:`, err);
        }
    }
    renderPendingOrdersTable();
}

/**
 * 渲染在途订单表格
 */
function renderPendingOrdersTable() {
    let orders = [];

    if (state.currentAccountId === null) {
        // 合并所有账户的在途订单
        for (const accountId in state.pendingOrders) {
            const account = state.accounts.find(a => a.id === accountId);
            const accountName = account ? account.name : accountId;
            for (const order of state.pendingOrders[accountId]) {
                orders.push({ ...order, accountName });
            }
        }
        // 按创建时间排序（新的在前）
        orders.sort((a, b) => {
            const timeA = a.created_at ? new Date(a.created_at) : 0;
            const timeB = b.created_at ? new Date(b.created_at) : 0;
            return timeB - timeA;
        });
    } else {
        orders = state.pendingOrders[state.currentAccountId] || [];
    }

    elements.pendingOrderCount.textContent = `${orders.length} 个挂单`;

    if (orders.length === 0) {
        elements.pendingOrdersTable.innerHTML = '';
        elements.noPendingOrders.classList.remove('hidden');
        return;
    }

    elements.noPendingOrders.classList.add('hidden');

    // 订单类型映射（保持英文）
    const typeMap = {
        'market': 'Market',
        'limit': 'Limit',
        'post_only': 'Post Only',
        'fok': 'FOK',
        'ioc': 'IOC',
    };

    // 状态映射
    const stateMap = {
        'live': '待成交',
        'partially_filled': '部分成交',
    };

    const showAccountName = state.currentAccountId === null;

    let html = '';
    for (const order of orders) {
        const isBuy = order.side === 'buy';

        // 开平仓方向（保持英文）
        let posSideText = '-';
        if (order.pos_side === 'long') {
            posSideText = isBuy ? 'Open Long' : 'Close Long';
        } else if (order.pos_side === 'short') {
            posSideText = isBuy ? 'Close Short' : 'Open Short';
        } else if (order.pos_side === 'net') {
            posSideText = isBuy ? 'Buy' : 'Sell';
        }

        const typeText = typeMap[order.order_type] || order.order_type;
        const stateText = stateMap[order.state] || order.state;

        // 状态颜色
        const stateClass = order.state === 'partially_filled' ? 'bg-accent/20 text-accent' : 'bg-app-elevated';

        // 时间格式化（兼容 ISO 字符串和毫秒时间戳）
        let timeStr = '-';
        if (order.created_at) {
            let time;
            if (typeof order.created_at === 'string') {
                // 检查是否是纯数字（毫秒时间戳）
                if (/^\d+$/.test(order.created_at)) {
                    time = new Date(parseInt(order.created_at));
                } else {
                    // ISO 格式字符串
                    time = new Date(order.created_at);
                }
            } else if (typeof order.created_at === 'number') {
                time = new Date(order.created_at);
            }
            if (time && !isNaN(time.getTime())) {
                timeStr = time.toLocaleString('zh-CN');
            }
        }

        // 已成交进度
        const fillProgress = order.sz > 0 ? ((order.fill_sz / order.sz) * 100).toFixed(1) : 0;

        // 开平方向的颜色样式
        const isLong = posSideText.includes('Long') || posSideText === 'Buy';
        const posSideClass = isLong ? 'text-profit' : 'text-loss';
        const posSideBgClass = isLong ? 'bg-profit/15' : 'bg-loss/15';

        // 检查是否有止盈止损
        const hasSlTp = order.sl_trigger_px || order.tp_trigger_px;
        
        // 止损价格显示 (sl_ord_px 为 -1 表示市价)
        let slPxText = '';
        if (order.sl_trigger_px) {
            const slOrdText = order.sl_ord_px === -1 ? '市价' : (order.sl_ord_px ? formatPrice(order.sl_ord_px) : '市价');
            slPxText = `触发: ${formatPrice(order.sl_trigger_px)} → ${slOrdText}`;
        }
        
        // 止盈价格显示 (tp_ord_px 为 -1 表示市价)
        let tpPxText = '';
        if (order.tp_trigger_px) {
            const tpOrdText = order.tp_ord_px === -1 ? '市价' : (order.tp_ord_px ? formatPrice(order.tp_ord_px) : '市价');
            tpPxText = `触发: ${formatPrice(order.tp_trigger_px)} → ${tpOrdText}`;
        }

        html += `
            <tr class="table-row-hover border-b border-app-separator">
                <td class="px-6 py-3.5 text-sm">
                    ${timeStr}
                    ${showAccountName ? `<div class="text-xs text-text-muted mt-1">${order.accountName}</div>` : ''}
                </td>
                <td class="px-6 py-3.5 font-mono text-sm font-medium">${order.inst_id}</td>
                <td class="px-6 py-3.5">
                    <span class="px-2.5 py-1 rounded-md text-xs font-medium ${posSideClass} ${posSideBgClass}">
                        ${posSideText}
                    </span>
                </td>
                <td class="px-6 py-3.5 text-sm text-text-muted">${typeText}</td>
                <td class="px-6 py-3.5 text-right font-mono text-sm">${order.px ? formatPrice(order.px) : '-'}</td>
                <td class="px-6 py-3.5 text-right font-mono text-sm">${order.sz}</td>
                <td class="px-6 py-3.5 text-right font-mono text-sm">
                    <span class="${order.fill_sz > 0 ? 'text-accent' : 'text-text-muted'}">${order.fill_sz}</span>
                    ${order.fill_sz > 0 ? `<span class="text-xs text-text-muted ml-1">(${fillProgress}%)</span>` : ''}
                </td>
                <td class="px-6 py-3.5 text-right font-mono text-sm text-text-muted">${order.avg_px ? formatPrice(order.avg_px) : '-'}</td>
                <td class="px-6 py-3.5">
                    <div class="flex items-center justify-between gap-2">
                        <span class="px-2 py-1 rounded-md text-xs font-medium ${stateClass}">${stateText}</span>
                        ${detailBtnHtml('pendingOrder', order)}
                    </div>
                </td>
            </tr>
            ${hasSlTp ? `
            <tr class="bg-app-surface/50">
                <td colspan="9" class="px-6 py-2">
                    <div class="flex items-center gap-6 text-xs">
                        ${order.sl_trigger_px ? `
                        <div class="flex items-center gap-2">
                            <span class="px-1.5 py-0.5 rounded bg-loss/20 text-loss font-medium">止损</span>
                            <span class="font-mono text-text-secondary">${slPxText}</span>
                        </div>
                        ` : ''}
                        ${order.tp_trigger_px ? `
                        <div class="flex items-center gap-2">
                            <span class="px-1.5 py-0.5 rounded bg-profit/20 text-profit font-medium">止盈</span>
                            <span class="font-mono text-text-secondary">${tpPxText}</span>
                        </div>
                        ` : ''}
                    </div>
                </td>
            </tr>
            ` : ''}
        `;
    }

    elements.pendingOrdersTable.innerHTML = html;
}

/**
 * 加载历史订单（支持分页）
 */
async function loadOrders(resetPage = true, options = {}) {
    if (state.currentAccountId === null) {
        // 全部账户模式暂不支持分页
        await loadAllAccountsOrders(options);
        return;
    }

    // 重置分页状态
    if (resetPage) {
        state.ordersPagination = { page: 1, cursors: [null], hasMore: false };
    }

    const startInput = document.getElementById('order-start').value;
    const endInput = document.getElementById('order-end').value;
    const currentCursor = state.ordersPagination.cursors[state.ordersPagination.page - 1];

    let url = `/api/accounts/${state.currentAccountId}/orders?limit=50`;
    if (startInput) {
        url += `&start=${new Date(startInput).toISOString()}`;
    }
    if (endInput) {
        url += `&end=${new Date(endInput).toISOString()}`;
    }
    if (currentCursor) {
        url += `&after=${currentCursor}`;
    }

    const { preserveExisting = false } = options || {};
    elements.ordersLoading.classList.remove('hidden');
    elements.noOrders.classList.add('hidden');
    if (!preserveExisting) {
        elements.ordersTable.innerHTML = '';
    }
    elements.ordersPagination.classList.add('hidden');

    try {
        const resp = await fetch(url);
        const data = await resp.json();
        
        // 更新分页状态
        state.ordersPagination.hasMore = data.has_more;
        if (data.has_more && data.last_id) {
            state.ordersPagination.cursors[state.ordersPagination.page] = data.last_id;
        }
        
        renderOrdersTable(data.items);

        // 仅缓存第 1 页（用于 tab 切回时立即恢复到第 1 页）
        if (state.ordersPagination.page === 1) {
            const key = getAccountKey();
            state.cache.orders[key] = {
                items: data.items,
                hasMore: data.has_more,
                lastId: data.last_id,
                fetchedAt: nowMs(),
                showAccountName: false,
            };
        }
        updateOrdersPagination();
    } catch (err) {
        console.error('Failed to load orders:', err);
        elements.ordersTable.innerHTML = `<tr><td colspan="9" class="px-6 py-4 text-center text-loss">加载失败: ${err.message}</td></tr>`;
    } finally {
        elements.ordersLoading.classList.add('hidden');
    }
}

/**
 * 更新订单分页控件状态
 */
function updateOrdersPagination() {
    const { page, hasMore } = state.ordersPagination;
    const shouldShow = page > 1 || hasMore;
    elements.ordersPagination.classList.toggle('hidden', !shouldShow);
    if (!shouldShow) return;
    elements.ordersPageInfo.textContent = `第 ${page} 页`;
    elements.ordersPrevBtn.disabled = page <= 1;
    elements.ordersNextBtn.disabled = !hasMore;
}

/**
 * 订单上一页
 */
function ordersPrevPage() {
    if (state.ordersPagination.page > 1) {
        state.ordersPagination.page--;
        loadOrders(false);
    }
}

/**
 * 订单下一页
 */
function ordersNextPage() {
    if (state.ordersPagination.hasMore) {
        state.ordersPagination.page++;
        loadOrders(false);
    }
}

/**
 * 加载所有账户的订单（不支持分页，只加载第一页）
 */
async function loadAllAccountsOrders(options = {}) {
    const { preserveExisting = false } = options || {};
    const startInput = document.getElementById('order-start').value;
    const endInput = document.getElementById('order-end').value;

    elements.ordersLoading.classList.remove('hidden');
    elements.noOrders.classList.add('hidden');
    if (!preserveExisting) {
        elements.ordersTable.innerHTML = '';
    }
    elements.ordersPagination.classList.add('hidden');

    const allOrders = [];

    try {
        for (const account of state.accounts) {
            let url = `/api/accounts/${account.id}/orders?limit=50`;
            if (startInput) {
                url += `&start=${new Date(startInput).toISOString()}`;
            }
            if (endInput) {
                url += `&end=${new Date(endInput).toISOString()}`;
            }

            const resp = await fetch(url);
            const data = await resp.json();

            for (const order of data.items) {
                allOrders.push({ ...order, accountName: account.name });
            }
        }

        // 按时间排序
        allOrders.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        renderOrdersTable(allOrders, true);

        // 缓存（全部账户：无分页）
        state.cache.orders[ACCOUNT_KEY_ALL] = {
            items: allOrders,
            hasMore: false,
            lastId: null,
            fetchedAt: nowMs(),
            showAccountName: true,
        };
    } catch (err) {
        console.error('Failed to load orders:', err);
        elements.ordersTable.innerHTML = `<tr><td colspan="9" class="px-6 py-4 text-center text-loss">加载失败: ${err.message}</td></tr>`;
    } finally {
        elements.ordersLoading.classList.add('hidden');
    }
}

/**
 * 加载账单流水（支持分页）
 */
async function loadBills(resetPage = true, options = {}) {
    if (state.currentAccountId === null) {
        // 全部账户模式暂不支持分页
        await loadAllAccountsBills(options);
        return;
    }

    // 重置分页状态
    if (resetPage) {
        state.billsPagination = { page: 1, cursors: [null], hasMore: false };
    }

    const billType = document.getElementById('bill-type').value;
    const startInput = document.getElementById('bill-start').value;
    const endInput = document.getElementById('bill-end').value;
    const currentCursor = state.billsPagination.cursors[state.billsPagination.page - 1];

    let url = `/api/accounts/${state.currentAccountId}/bills?limit=50`;
    if (billType) {
        url += `&bill_type=${billType}`;
    }
    if (startInput) {
        url += `&start=${new Date(startInput).toISOString()}`;
    }
    if (endInput) {
        url += `&end=${new Date(endInput).toISOString()}`;
    }
    if (currentCursor) {
        url += `&after=${currentCursor}`;
    }

    const { preserveExisting = false } = options || {};
    elements.billsLoading.classList.remove('hidden');
    elements.noBills.classList.add('hidden');
    if (!preserveExisting) {
        elements.billsTable.innerHTML = '';
    }
    elements.billsPagination.classList.add('hidden');

    try {
        const resp = await fetch(url);
        const data = await resp.json();
        
        // 更新分页状态
        state.billsPagination.hasMore = data.has_more;
        if (data.has_more && data.last_id) {
            state.billsPagination.cursors[state.billsPagination.page] = data.last_id;
        }
        
        renderBillsTable(data.items);

        // 仅缓存第 1 页
        if (state.billsPagination.page === 1) {
            const key = getAccountKey();
            state.cache.bills[key] = {
                items: data.items,
                hasMore: data.has_more,
                lastId: data.last_id,
                fetchedAt: nowMs(),
                showAccountName: false,
            };
        }
        updateBillsPagination();
    } catch (err) {
        console.error('Failed to load bills:', err);
        elements.billsTable.innerHTML = `<tr><td colspan="9" class="px-6 py-4 text-center text-loss">加载失败: ${err.message}</td></tr>`;
    } finally {
        elements.billsLoading.classList.add('hidden');
    }
}

/**
 * 更新账单分页控件状态
 */
function updateBillsPagination() {
    const { page, hasMore } = state.billsPagination;
    const shouldShow = page > 1 || hasMore;
    elements.billsPagination.classList.toggle('hidden', !shouldShow);
    if (!shouldShow) return;
    elements.billsPageInfo.textContent = `第 ${page} 页`;
    elements.billsPrevBtn.disabled = page <= 1;
    elements.billsNextBtn.disabled = !hasMore;
}

/**
 * 账单上一页
 */
function billsPrevPage() {
    if (state.billsPagination.page > 1) {
        state.billsPagination.page--;
        loadBills(false);
    }
}

/**
 * 账单下一页
 */
function billsNextPage() {
    if (state.billsPagination.hasMore) {
        state.billsPagination.page++;
        loadBills(false);
    }
}

/**
 * 加载所有账户的账单（不支持分页，只加载第一页）
 */
async function loadAllAccountsBills(options = {}) {
    const { preserveExisting = false } = options || {};
    const billType = document.getElementById('bill-type').value;
    const startInput = document.getElementById('bill-start').value;
    const endInput = document.getElementById('bill-end').value;

    elements.billsLoading.classList.remove('hidden');
    elements.noBills.classList.add('hidden');
    if (!preserveExisting) {
        elements.billsTable.innerHTML = '';
    }
    elements.billsPagination.classList.add('hidden');

    const allBills = [];

    try {
        for (const account of state.accounts) {
            let url = `/api/accounts/${account.id}/bills?limit=50`;
            if (billType) {
                url += `&bill_type=${billType}`;
            }
            if (startInput) {
                url += `&start=${new Date(startInput).toISOString()}`;
            }
            if (endInput) {
                url += `&end=${new Date(endInput).toISOString()}`;
            }

            const resp = await fetch(url);
            const data = await resp.json();

            for (const bill of data.items) {
                allBills.push({ ...bill, accountName: account.name });
            }
        }

        // 按时间排序
        allBills.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        renderBillsTable(allBills, true);

        // 缓存（全部账户：无分页）
        state.cache.bills[ACCOUNT_KEY_ALL] = {
            items: allBills,
            hasMore: false,
            lastId: null,
            fetchedAt: nowMs(),
            showAccountName: true,
        };
    } catch (err) {
        console.error('Failed to load bills:', err);
        elements.billsTable.innerHTML = `<tr><td colspan="9" class="px-6 py-4 text-center text-loss">加载失败: ${err.message}</td></tr>`;
    } finally {
        elements.billsLoading.classList.add('hidden');
    }
}

/**
 * 渲染账单表格
 */
function renderBillsTable(bills, showAccountName = false) {
    if (bills.length === 0) {
        elements.billsTable.innerHTML = '';
        elements.noBills.classList.remove('hidden');
        elements.billSummary.textContent = '';
        return;
    }

    elements.noBills.classList.add('hidden');

    // 计算汇总
    let totalPnl = 0;
    let totalFee = 0;
    for (const bill of bills) {
        totalPnl += bill.pnl || 0;
        totalFee += bill.fee || 0;
    }
    const pnlText = (totalPnl >= 0 ? '+' : '') + formatNumber(totalPnl);
    const pnlClass = totalPnl >= 0 ? 'text-profit' : 'text-loss';
    elements.billSummary.innerHTML = `共 ${bills.length} 条 | 总收益: <span class="${pnlClass} font-medium">${pnlText}</span> | 总手续费: ${formatNumber(Math.abs(totalFee))}`;

    // 账单类型映射
    const billTypeMap = {
        '1': '划转',
        '2': '交易',
        '3': '交割',
        '4': '强减',
        '5': '强平',
        '6': '保证金划转',
        '7': '利息',
        '8': '资金费',
        '9': 'ADL',
        '10': '爆仓补偿',
        '11': '系统换币',
        '12': '策略划转',
        '13': '对冲减仓',
        '14': 'ADL补偿',
        '15': '闪兑',
        '18': '期权行权',
        '19': '期权分摊',
        '20': '期权组合',
        '21': 'Block交易',
        '22': '返佣',
        '24': 'Spread交易',
        '25': '结构化产品',
        '26': '合约赎回',
        '27': '借贷',
        '28': '还贷',
        '29': 'VIP借币',
        '30': 'VIP还币',
        '31': 'VIP利息',
        '32': '系统',
    };

    // 子类型映射
    const subTypeMap = {
        // 交易相关
        '1': '买入',
        '2': '卖出',
        '3': '开多',
        '4': '开空',
        '5': '平多',
        '6': '平空',
        '7': '部分平多',
        '8': '部分平空',
        // 爆仓
        '9': '爆仓平多',
        '10': '爆仓平空',
        '11': '部分爆仓平多',
        '12': '部分爆仓平空',
        // 划转
        '37': '从现货划入',
        '38': '划出至现货',
        '39': '从交易划入',
        '40': '划出至交易',
        '41': '从资金划入',
        '42': '划出至资金',
        // 手续费
        '100': '手续费扣除',
        '101': '手续费返还',
        '102': 'Maker 返佣',
        '103': 'Taker 手续费',
        '104': 'Maker 手续费',
        '105': '经纪商返佣',
        '106': '推荐人返佣',
        '107': '跟单手续费',
        // 资金费
        '173': '资金费支出',
        '174': '资金费收入',
        // 利息
        '169': '杠杆借币利息',
        '170': '杠杆利息扣除',
        '171': '逐仓利息扣除',
        '172': '全仓利息扣除',
        '175': 'VIP借币利息',
        '176': '逐仓利息',
        '177': '全仓利息',
        // ADL
        '180': 'ADL平多',
        '181': 'ADL平空',
        '182': 'ADL部分平多',
        '183': 'ADL部分平空',
        // 爆仓接管
        '14': '爆仓由他人接管',
        '15': '接管他人爆仓',
        // 保险基金
        '204': '保险基金注入',
        '205': '保险基金注出',
        // 期权
        '110': '期权行权',
        '111': '期权被行权',
        '118': '期权分摊',
        // 交割
        '112': '交割多头',
        '113': '交割空头',
        // 系统
        '160': '系统扣除',
        '161': '系统增加',
        '162': '空投',
        '163': '手动增加',
        '164': '手动扣除',
        // 闪兑
        '200': '闪兑买入',
        '201': '闪兑卖出',
        // 借贷
        '184': '借币',
        '185': '还币',
        '186': '借币利息',
        '187': '借币手续费',
    };

    let html = '';
    for (const bill of bills) {
        const typeText = billTypeMap[bill.bill_type] || bill.bill_type;
        const subTypeText = subTypeMap[bill.sub_type] || bill.sub_type || '-';
        const time = new Date(bill.timestamp).toLocaleString('zh-CN');

        const pnl = bill.pnl || 0;
        const pnlText = pnl !== 0 ? ((pnl >= 0 ? '+' : '') + formatNumber(pnl)) : '-';
        const pnlClass = pnl >= 0 ? 'text-profit' : 'text-loss';

        const fee = bill.fee || 0;
        const feeText = fee !== 0 ? formatNumber(fee) : '-';

        const balChg = bill.bal_chg || 0;
        const balChgText = balChg !== 0 ? ((balChg >= 0 ? '+' : '') + formatNumber(balChg)) : '-';
        const balChgClass = balChg >= 0 ? 'text-profit' : 'text-loss';

        // 根据余额变动添加行高亮
        const rowHighlight = balChg !== 0 ? (balChg >= 0 ? 'profit-highlight' : 'loss-highlight') : '';

        // 子类型样式
        let subTypeClass = 'text-text-secondary';
        // Maker 返佣、资金费收入、返还类 - 绿色
        const profitSubTypes = ['101', '102', '104', '105', '106', '174', '162', '163', '205'];
        // Taker 手续费、利息扣除、资金费支出 - 红色
        const lossSubTypes = ['103', '169', '170', '171', '172', '173', '175', '176', '177', '160', '164', '186', '187'];
        
        if (profitSubTypes.includes(bill.sub_type)) {
            subTypeClass = 'text-profit';
        } else if (lossSubTypes.includes(bill.sub_type)) {
            subTypeClass = 'text-loss';
        }

        // Taker/Maker 显示
        let execTypeText = '-';
        let execTypeClass = 'text-text-muted';
        let execTypeBg = '';
        if (bill.exec_type === 'T') {
            execTypeText = 'T';
            execTypeClass = 'text-loss';
            execTypeBg = 'bg-loss/15';
        } else if (bill.exec_type === 'M') {
            execTypeText = 'M';
            execTypeClass = 'text-profit';
            execTypeBg = 'bg-profit/15';
        }

        // 账单类型颜色
        let typeClass = 'bg-app-elevated';
        if (bill.bill_type === '2') typeClass = 'bg-accent/15 text-accent'; // 交易
        else if (bill.bill_type === '8') typeClass = 'bg-funding/15 text-funding'; // 资金费
        else if (bill.bill_type === '1') typeClass = 'bg-transfer/15 text-transfer'; // 划转

        html += `
            <tr class="table-row-hover ${rowHighlight}">
                <td class="px-6 py-3.5 text-sm">
                    ${time}
                    ${showAccountName ? `<div class="text-xs text-text-muted mt-1">${bill.accountName}</div>` : ''}
                </td>
                <td class="px-6 py-3.5 text-sm">
                    <span class="px-2 py-1 rounded-md text-xs font-medium ${typeClass}">${typeText}</span>
                </td>
                <td class="px-6 py-3.5 text-sm ${subTypeClass}">${subTypeText}</td>
                <td class="px-6 py-3.5 text-center text-sm">
                    ${execTypeText !== '-' ? `<span class="px-1.5 py-0.5 rounded text-xs font-semibold ${execTypeClass} ${execTypeBg}">${execTypeText}</span>` : '<span class="text-text-muted">-</span>'}
                </td>
                <td class="px-6 py-3.5 font-mono text-sm">${bill.inst_id || '-'}</td>
                <td class="px-6 py-3.5 text-right font-mono text-sm font-semibold ${pnlClass}">${pnlText}</td>
                <td class="px-6 py-3.5 text-right font-mono text-sm text-text-muted">${feeText}</td>
                <td class="px-6 py-3.5 text-right font-mono text-sm font-semibold ${balChgClass}">${balChgText}</td>
                <td class="px-6 py-3.5 text-right font-mono text-sm text-text-muted">
                    <div class="flex items-center justify-end gap-2">
                        <span>${formatNumber(bill.bal)}</span>
                        ${detailBtnHtml('bill', bill)}
                    </div>
                </td>
            </tr>
        `;
    }

    elements.billsTable.innerHTML = html;
}

/**
 * 加载历史仓位（支持分页）
 */
async function loadPositionHistory(resetPage = true, options = {}) {
    // 必须选择单个账户
    if (state.currentAccountId === null) {
        // 默认选择第一个账户
        if (state.accounts.length > 0) {
            const firstAccountId = state.accounts[0].id;
            selectAccount(firstAccountId);
            return;
        }
        alert('请先选择一个账户');
        return;
    }

    // 重置分页状态
    if (resetPage) {
        state.posHistoryPagination = { page: 1, cursors: [null], hasMore: false };
    }

    const startInput = document.getElementById('pos-history-start').value;
    const endInput = document.getElementById('pos-history-end').value;
    const instId = document.getElementById('pos-history-inst').value.trim();
    const posSide = document.getElementById('pos-history-side').value;
    const currentCursor = state.posHistoryPagination.cursors[state.posHistoryPagination.page - 1];

    let url = `/api/accounts/${state.currentAccountId}/positions-history?limit=50`;
    if (startInput) {
        url += `&start=${new Date(startInput).toISOString()}`;
    }
    if (endInput) {
        url += `&end=${new Date(endInput).toISOString()}`;
    }
    if (instId) {
        url += `&inst_id=${encodeURIComponent(instId)}`;
    }
    if (posSide) {
        url += `&pos_side=${posSide}`;
    }
    if (currentCursor) {
        url += `&after=${currentCursor}`;
    }

    const { preserveExisting = false } = options || {};
    elements.posHistoryLoading.classList.remove('hidden');
    elements.noPosHistory.classList.add('hidden');
    if (!preserveExisting) {
        elements.posHistoryContainer.innerHTML = '';
    }
    elements.posHistoryPagination.classList.add('hidden');

    try {
        const resp = await fetch(url);
        const data = await resp.json();

        // 更新分页状态
        state.posHistoryPagination.hasMore = data.has_more;
        if (data.has_more && data.last_id) {
            state.posHistoryPagination.cursors[state.posHistoryPagination.page] = data.last_id;
        }

        renderPositionHistoryCards(data.items);

        // 仅缓存第 1 页
        if (state.posHistoryPagination.page === 1) {
            const key = getAccountKey();
            state.cache.posHistory[key] = {
                items: data.items,
                hasMore: data.has_more,
                lastId: data.last_id,
                fetchedAt: nowMs(),
            };
        }
        updatePosHistoryPagination();
    } catch (err) {
        console.error('Failed to load position history:', err);
        elements.posHistoryContainer.innerHTML = `<div class="col-span-full text-center text-loss py-8">加载失败: ${err.message}</div>`;
    } finally {
        elements.posHistoryLoading.classList.add('hidden');
    }
}

/**
 * 更新历史仓位分页控件状态
 */
function updatePosHistoryPagination() {
    const { page, hasMore } = state.posHistoryPagination;

    const shouldShow = page > 1 || hasMore;
    elements.posHistoryPagination.classList.toggle('hidden', !shouldShow);
    if (!shouldShow) return;
    elements.posHistoryPageInfo.textContent = `第 ${page} 页`;
    elements.posHistoryPrevBtn.disabled = page <= 1;
    elements.posHistoryNextBtn.disabled = !hasMore;
}

/**
 * 历史仓位上一页
 */
function posHistoryPrevPage() {
    if (state.posHistoryPagination.page > 1) {
        state.posHistoryPagination.page--;
        loadPositionHistory(false);
    }
}

/**
 * 历史仓位下一页
 */
function posHistoryNextPage() {
    if (state.posHistoryPagination.hasMore) {
        state.posHistoryPagination.page++;
        loadPositionHistory(false);
    }
}

/**
 * 渲染历史仓位卡片
 */
function renderPositionHistoryCards(positions) {
    if (positions.length === 0) {
        elements.posHistoryContainer.innerHTML = '';
        elements.noPosHistory.classList.remove('hidden');
        return;
    }

    elements.noPosHistory.classList.add('hidden');

    let html = '';
    for (const pos of positions) {
        const isLong = pos.pos_side === 'long';
        const directionText = isLong ? '多' : '空';
        const directionClass = isLong ? 'text-profit' : 'text-loss';
        const directionBgClass = isLong ? 'bg-profit/20' : 'bg-loss/20';
        const borderClass = pos.pnl >= 0 ? 'border-profit/30' : 'border-loss/30';

        // 盈亏
        const pnlText = (pos.pnl >= 0 ? '+' : '') + formatNumber(pos.pnl);
        const pnlClass = pos.pnl >= 0 ? 'text-profit' : 'text-loss';
        const pnlGlow = pos.pnl >= 0 ? 'glow-profit' : 'glow-loss';

        // 收益率
        const pnlRatioText = (pos.pnl_ratio >= 0 ? '+' : '') + (pos.pnl_ratio * 100).toFixed(2) + '%';
        const pnlRatioClass = pos.pnl_ratio >= 0 ? 'text-profit' : 'text-loss';

        // 收益率进度条
        const progressPercent = Math.min(Math.abs(pos.pnl_ratio * 100), 100);
        const progressColor = pos.pnl_ratio >= 0 ? 'bg-profit' : 'bg-loss';

        // 时间格式化
        const openTime = formatPosHistoryTime(pos.created_at);
        const closeTime = formatPosHistoryTime(pos.updated_at);

        // 持仓时长
        const duration = calculateDuration(pos.created_at, pos.updated_at);

        // 手续费 + 资金费
        const totalFee = (pos.fee || 0) + (pos.funding_fee || 0);

        html += `
            <div class="position-card relative bg-app-elevated rounded-xl p-4 border ${borderClass} hover:bg-app-surface transition-all">
                <!-- 悬浮详情按钮 -->
                <div class="absolute top-2 right-2">
                    ${detailBtnHtml('positionHistory', pos)}
                </div>
                <!-- 头部：合约名 + 方向 + 杠杆 -->
                <div class="flex items-center justify-between mb-3 pr-12">
                    <div class="flex items-center gap-2">
                        <span class="font-mono text-sm font-semibold text-text-primary">${pos.inst_id}</span>
                        <span class="px-2 py-0.5 rounded text-xs font-semibold ${directionClass} ${directionBgClass}">
                            ${directionText}
                        </span>
                    </div>
                    <span class="text-xs text-text-muted font-mono">${pos.lever}x</span>
                </div>

                <!-- 时间信息 -->
                <div class="flex justify-between text-xs text-text-muted mb-3">
                    <span>开仓: ${openTime}</span>
                    <span>持仓: ${duration}</span>
                </div>

                <!-- 核心数据 -->
                <div class="grid grid-cols-2 gap-x-4 gap-y-2 mb-3 text-xs">
                    <div class="flex justify-between">
                        <span class="text-text-muted">开仓价</span>
                        <span class="font-mono text-text-secondary">${formatPrice(pos.open_avg_px)}</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-text-muted">平仓价</span>
                        <span class="font-mono text-text-primary">${formatPrice(pos.close_avg_px)}</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-text-muted">最大持仓</span>
                        <span class="font-mono text-text-secondary">${pos.open_max_pos}</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-text-muted">累计平仓</span>
                        <span class="font-mono text-text-secondary">${pos.close_total_pos}</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-text-muted">手续费</span>
                        <span class="font-mono text-text-muted">${formatNumber(Math.abs(pos.fee))}</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-text-muted">资金费</span>
                        <span class="font-mono ${pos.funding_fee >= 0 ? 'text-profit' : 'text-loss'}">${pos.funding_fee >= 0 ? '+' : ''}${formatNumber(pos.funding_fee)}</span>
                    </div>
                </div>

                <!-- 盈亏区域 -->
                <div class="pt-3 border-t border-app-separator">
                    <div class="flex items-baseline justify-between mb-2">
                        <span class="text-3xl font-mono font-bold ${pnlClass} ${pnlGlow}">$${pnlText}</span>
                        <span class="text-sm font-mono font-semibold ${pnlRatioClass}">${pnlRatioText}</span>
                    </div>
                    <!-- 收益率进度条 -->
                    <div class="h-1.5 bg-app-surface rounded-full overflow-hidden">
                        <div class="h-full ${progressColor} rounded-full transition-all" style="width: ${progressPercent}%"></div>
                    </div>
                    <!-- 平仓时间 -->
                    <div class="text-xs text-text-muted mt-2 text-right">
                        平仓: ${closeTime}
                    </div>
                </div>
            </div>
        `;
    }

    elements.posHistoryContainer.innerHTML = html;
}

/**
 * 格式化历史仓位时间
 */
function formatPosHistoryTime(val) {
    if (!val) return '--';
    const d = typeof val === 'string' ? new Date(val) : val;
    if (isNaN(d.getTime())) return '--';
    return d.toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });
}

/**
 * 计算持仓时长
 */
function calculateDuration(start, end) {
    if (!start || !end) return '--';
    const startDate = typeof start === 'string' ? new Date(start) : start;
    const endDate = typeof end === 'string' ? new Date(end) : end;
    
    const diffMs = endDate - startDate;
    if (diffMs < 0) return '--';

    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffDays > 0) {
        const hours = diffHours % 24;
        return `${diffDays}天${hours}小时`;
    } else if (diffHours > 0) {
        const mins = diffMins % 60;
        return `${diffHours}小时${mins}分`;
    } else {
        return `${diffMins}分钟`;
    }
}

/**
 * 加载资产曲线数据
 */
async function loadEquityCurve(options = {}) {
    const { preserveExisting = false } = options || {};
    // 必须选择单个账户
    if (state.currentAccountId === null) {
        // 默认选择第一个账户
        if (state.accounts.length > 0) {
            const firstAccountId = state.accounts[0].id;
            selectAccount(firstAccountId);
            return;
        }
        alert('请先选择一个账户');
        return;
    }

    const days = document.getElementById('equity-days').value;
    const interval = document.getElementById('equity-interval').value;

    const loadingEl = document.getElementById('equity-loading');
    const noDataEl = document.getElementById('no-equity-data');
    
    loadingEl.classList.remove('hidden');
    if (!preserveExisting) {
        noDataEl.classList.add('hidden');
    }

    try {
        const url = `/api/accounts/${state.currentAccountId}/equity-curve?days=${days}&interval=${interval}`;
        const resp = await fetch(url);
        const data = await resp.json();

        if (!data.points || data.points.length === 0) {
            noDataEl.classList.remove('hidden');
            // 清除旧图表
            if (state.equityChart) {
                state.equityChart.destroy();
                state.equityChart = null;
            }
            state.equityCurvePoints = null;
            // 清除汇总数据
            document.getElementById('equity-start').textContent = '--';
            document.getElementById('equity-end').textContent = '--';
            document.getElementById('equity-change').textContent = '--';
            document.getElementById('equity-points').textContent = '--';

            // 缓存空结果，避免频繁重复请求
            state.cache.equityCurve[getAccountKey()] = { data, fetchedAt: nowMs() };
            return;
        }

        // 更新汇总信息
        const startBal = data.start_balance || 0;
        const endBal = data.end_balance || 0;
        const change = endBal - startBal;
        const changePercent = startBal > 0 ? ((change / startBal) * 100).toFixed(2) : 0;

        document.getElementById('equity-start').textContent = '$' + formatNumber(startBal);
        document.getElementById('equity-end').textContent = '$' + formatNumber(endBal);
        
        const changeText = (change >= 0 ? '+' : '') + formatNumber(change) + ` (${change >= 0 ? '+' : ''}${changePercent}%)`;
        const changeEl = document.getElementById('equity-change');
        changeEl.textContent = changeText;
        changeEl.className = `text-xl font-mono font-semibold ${change >= 0 ? 'text-profit' : 'text-loss'}`;
        
        document.getElementById('equity-points').textContent = data.total_points;

        // 渲染图表
        state.equityCurvePoints = data.points;
        renderEquityChart(data.points);

        // 缓存（按账户）
        state.cache.equityCurve[getAccountKey()] = { data, fetchedAt: nowMs() };

    } catch (err) {
        console.error('Failed to load equity curve:', err);
        state.equityCurvePoints = null;
        noDataEl.classList.remove('hidden');
    } finally {
        loadingEl.classList.add('hidden');
    }
}

/**
 * 渲染资产曲线图表
 */
function renderEquityChart(points) {
    const ctx = document.getElementById('equity-chart').getContext('2d');

    // 销毁旧图表
    if (state.equityChart) {
        state.equityChart.destroy();
    }

    // 准备数据
    const labels = points.map(p => {
        const d = new Date(p.timestamp);
        return d.toLocaleString('zh-CN', { 
            month: 'numeric', 
            day: 'numeric', 
            hour: '2-digit', 
            minute: '2-digit' 
        });
    });
    const data = points.map(p => p.balance);

    // 计算颜色（根据起止变化）
    const isProfit = data[data.length - 1] >= data[0];
    const lineVar = isProfit ? '--c-profit' : '--c-loss';
    const lineColor = cssRgba(lineVar, 1);
    const fillColor = cssRgba(lineVar, 0.12);

    state.equityChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: 'USDT 余额',
                data: data,
                borderColor: lineColor,
                backgroundColor: fillColor,
                borderWidth: 2,
                fill: true,
                tension: 0.1,
                pointRadius: points.length > 100 ? 0 : 3,
                pointHoverRadius: 5,
                pointBackgroundColor: lineColor,
                pointBorderColor: cssRgba('--c-surface', 1),
                pointBorderWidth: 2,
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                intersect: false,
                mode: 'index',
            },
            plugins: {
                legend: {
                    display: false,
                },
                tooltip: {
                    backgroundColor: cssRgba('--c-surface', 0.95),
                    titleColor: cssRgba('--c-text-secondary', 1),
                    bodyColor: cssRgba('--c-text-primary', 1),
                    borderColor: cssRgba('--c-glass-border', 0.12),
                    borderWidth: 1,
                    padding: 12,
                    displayColors: false,
                    callbacks: {
                        title: function(context) {
                            const idx = context[0].dataIndex;
                            const d = new Date(points[idx].timestamp);
                            return d.toLocaleString('zh-CN');
                        },
                        label: function(context) {
                            return `余额: $${formatNumber(context.raw)}`;
                        }
                    }
                }
            },
            scales: {
                x: {
                    grid: {
                        color: cssRgba('--c-separator', 0.30),
                        drawBorder: false,
                    },
                    ticks: {
                        color: cssRgba('--c-text-muted', 1),
                        maxTicksLimit: 8,
                        maxRotation: 0,
                    }
                },
                y: {
                    grid: {
                        color: cssRgba('--c-separator', 0.30),
                        drawBorder: false,
                    },
                    ticks: {
                        color: cssRgba('--c-text-muted', 1),
                        callback: function(value) {
                            return '$' + formatNumber(value);
                        }
                    }
                }
            }
        }
    });
}

/**
 * 渲染订单表格
 */
function renderOrdersTable(orders, showAccountName = false) {
    if (orders.length === 0) {
        elements.ordersTable.innerHTML = '';
        elements.noOrders.classList.remove('hidden');
        return;
    }

    elements.noOrders.classList.add('hidden');

    let html = '';
    for (const order of orders) {
        const isBuy = order.side === 'buy';
        const sideText = isBuy ? '买入' : '卖出';
        const sideClass = isBuy ? 'text-profit' : 'text-loss';
        const sideBgClass = isBuy ? 'bg-profit/15' : 'bg-loss/15';

        const typeMap = {
            'market': '市价',
            'limit': '限价',
            'post_only': '只挂单',
            'fok': 'FOK',
            'ioc': 'IOC',
        };
        const typeText = typeMap[order.order_type] || order.order_type;

        const stateMap = {
            'filled': '已成交',
            'canceled': '已撤销',
            'partially_filled': '部分成交',
            'live': '待成交',
        };
        const stateText = stateMap[order.state] || order.state;
        const stateClass = order.state === 'filled' ? 'bg-profit/15 text-profit' : 
                          order.state === 'canceled' ? 'bg-loss/15 text-loss' : 'bg-app-elevated';

        const pnlText = order.pnl ? ((order.pnl >= 0 ? '+' : '') + formatNumber(order.pnl)) : '-';
        const pnlClass = order.pnl >= 0 ? 'text-profit' : 'text-loss';
        
        // 根据盈亏添加行高亮
        const rowHighlight = order.pnl && Math.abs(order.pnl) > 0 ? 
            (order.pnl >= 0 ? 'profit-highlight' : 'loss-highlight') : '';

        const time = new Date(order.created_at).toLocaleString('zh-CN');

        html += `
            <tr class="table-row-hover ${rowHighlight}">
                <td class="px-6 py-3.5 text-sm">
                    ${time}
                    ${showAccountName ? `<div class="text-xs text-text-muted mt-1">${order.accountName}</div>` : ''}
                </td>
                <td class="px-6 py-3.5 font-mono text-sm font-medium">${order.inst_id}</td>
                <td class="px-6 py-3.5 text-sm">
                    <span class="px-2 py-1 rounded-md text-xs font-medium ${sideClass} ${sideBgClass}">${sideText}</span>
                </td>
                <td class="px-6 py-3.5 text-sm text-text-muted">${typeText}</td>
                <td class="px-6 py-3.5 text-right font-mono text-sm">${order.sz}</td>
                <td class="px-6 py-3.5 text-right font-mono text-sm text-text-muted">${order.avg_px ? formatPrice(order.avg_px) : '-'}</td>
                <td class="px-6 py-3.5 text-right font-mono text-sm font-semibold ${pnlClass}">${pnlText}</td>
                <td class="px-6 py-3.5 text-right font-mono text-sm text-text-muted">${formatNumber(Math.abs(order.fee))}</td>
                <td class="px-6 py-3.5 text-sm">
                    <div class="flex items-center justify-between gap-2">
                        <span class="px-2 py-1 rounded-md text-xs font-medium ${stateClass}">${stateText}</span>
                        ${detailBtnHtml('order', order)}
                    </div>
                </td>
            </tr>
        `;
    }

    elements.ordersTable.innerHTML = html;
}

/**
 * 刷新数据
 */
async function refreshData() {
    await loadInitialData();
}

// ========== 工具函数 ==========

function formatNumber(num) {
    if (num === null || num === undefined) return '--';
    return Number(num).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
}

function formatAssetNumber(num) {
    if (num === null || num === undefined) return '--';
    const n = Number(num);
    if (n === 0) return '0';
    if (n >= 1000) {
        return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    } else if (n >= 1) {
        return n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
    } else if (n >= 0.0001) {
        return n.toLocaleString('en-US', { minimumFractionDigits: 6, maximumFractionDigits: 6 });
    } else {
        return n.toLocaleString('en-US', { minimumFractionDigits: 8, maximumFractionDigits: 8 });
    }
}

function formatPrice(price) {
    if (price === null || price === undefined) return '--';
    const num = Number(price);
    if (num >= 1000) {
        return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    } else if (num >= 1) {
        return num.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
    } else {
        return num.toLocaleString('en-US', { minimumFractionDigits: 6, maximumFractionDigits: 6 });
    }
}

function formatDateTimeLocal(date) {
    const pad = (n) => n.toString().padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatOpenTime(val) {
    if (!val) return '--';
    const d = typeof val === 'string' ? new Date(val) : val;
    if (isNaN(d.getTime())) return '--';
    const pad = (n) => n.toString().padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ========== 详情弹窗 ==========

/**
 * 字段配置：定义各数据类型的字段分组和格式化方式
 */
const DETAIL_FIELD_CONFIG = {
    position: {
        title: 'Position Detail',
        groups: [
            {
                name: 'Basic',
                fields: [
                    { key: 'inst_id', label: 'Instrument' },
                    { key: 'pos_side', label: 'Side', format: (v) => v === 'long' ? 'Long' : v === 'short' ? 'Short' : 'Net' },
                    { key: 'pos', label: 'Size', format: (v) => Math.abs(v).toString() },
                    { key: 'lever', label: 'Leverage', format: (v) => v + 'x' },
                ],
            },
            {
                name: 'Price',
                fields: [
                    { key: 'avg_px', label: 'Entry Price', format: formatPrice },
                    { key: 'mark_px', label: 'Mark Price', format: formatPrice },
                    { key: 'liq_px', label: 'Liquidation Price', format: (v) => v ? formatPrice(v) : '--' },
                ],
            },
            {
                name: 'PnL',
                fields: [
                    { key: 'upl', label: 'Unrealized PnL', format: (v) => '$' + formatNumber(v), className: (v) => v >= 0 ? 'profit' : 'loss' },
                    { key: 'upl_ratio', label: 'PnL Ratio', format: (v) => (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + '%', className: (v) => v >= 0 ? 'profit' : 'loss' },
                    { key: 'margin', label: 'Margin', format: (v) => '$' + formatNumber(v) },
                ],
            },
            {
                name: 'Raw Data',
                fields: [
                    { key: 'created_at', label: 'Open Time', format: formatDetailDateTime },
                    { key: 'accountName', label: 'Account' },
                ],
            },
        ],
    },
    asset: {
        title: 'Asset Detail',
        groups: [
            {
                name: 'Basic',
                fields: [
                    { key: 'ccy', label: 'Currency' },
                ],
            },
            {
                name: 'Balance',
                fields: [
                    { key: 'bal', label: 'Total Balance', format: formatAssetNumber },
                    { key: 'avail_bal', label: 'Available', format: formatAssetNumber, className: () => 'profit' },
                    { key: 'frozen_bal', label: 'Frozen', format: formatAssetNumber, className: (v) => v > 0 ? 'loss' : 'muted' },
                ],
            },
            {
                name: 'Valuation',
                fields: [
                    { key: 'eq', label: 'Equity (USDT)', format: (v) => '$' + formatNumber(v) },
                    { key: 'eq_usd', label: 'Equity (USD)', format: (v) => v ? '$' + formatNumber(v) : '--' },
                ],
            },
        ],
    },
    pendingOrder: {
        title: 'Pending Order Detail',
        groups: [
            {
                name: 'Basic',
                fields: [
                    { key: 'inst_id', label: 'Instrument' },
                    { key: 'side', label: 'Side', format: (v) => v === 'buy' ? 'Buy' : 'Sell', className: (v) => v === 'buy' ? 'profit' : 'loss' },
                    { key: 'pos_side', label: 'Position Side', format: formatDetailPosSide },
                    { key: 'order_type', label: 'Order Type', format: formatDetailOrderType },
                    { key: 'state', label: 'State', format: formatDetailOrderState },
                    { key: 'lever', label: 'Leverage', format: (v) => v + 'x' },
                ],
            },
            {
                name: 'Price & Size',
                fields: [
                    { key: 'px', label: 'Order Price', format: (v) => v ? formatPrice(v) : 'Market' },
                    { key: 'sz', label: 'Order Size' },
                    { key: 'fill_sz', label: 'Filled Size', className: (v) => v > 0 ? 'profit' : 'muted' },
                    { key: 'avg_px', label: 'Avg Fill Price', format: (v) => v ? formatPrice(v) : '--' },
                ],
            },
            {
                name: 'Stop Loss / Take Profit',
                fields: [
                    { key: 'sl_trigger_px', label: 'SL Trigger', format: (v) => v ? formatPrice(v) : '--' },
                    { key: 'sl_ord_px', label: 'SL Order Price', format: (v) => v === -1 ? 'Market' : v ? formatPrice(v) : '--' },
                    { key: 'tp_trigger_px', label: 'TP Trigger', format: (v) => v ? formatPrice(v) : '--' },
                    { key: 'tp_ord_px', label: 'TP Order Price', format: (v) => v === -1 ? 'Market' : v ? formatPrice(v) : '--' },
                ],
            },
            {
                name: 'Raw Data',
                fields: [
                    { key: 'order_id', label: 'Order ID' },
                    { key: 'created_at', label: 'Created', format: formatDetailDateTime },
                    { key: 'updated_at', label: 'Updated', format: formatDetailDateTime },
                    { key: 'accountName', label: 'Account' },
                ],
            },
        ],
    },
    order: {
        title: 'Order Detail',
        groups: [
            {
                name: 'Basic',
                fields: [
                    { key: 'inst_id', label: 'Instrument' },
                    { key: 'side', label: 'Side', format: (v) => v === 'buy' ? 'Buy' : 'Sell', className: (v) => v === 'buy' ? 'profit' : 'loss' },
                    { key: 'pos_side', label: 'Position Side', format: formatDetailPosSide },
                    { key: 'order_type', label: 'Order Type', format: formatDetailOrderType },
                    { key: 'state', label: 'State', format: formatDetailOrderState },
                ],
            },
            {
                name: 'Price & Size',
                fields: [
                    { key: 'px', label: 'Order Price', format: (v) => v ? formatPrice(v) : 'Market' },
                    { key: 'sz', label: 'Size' },
                    { key: 'avg_px', label: 'Avg Fill Price', format: (v) => v ? formatPrice(v) : '--' },
                ],
            },
            {
                name: 'PnL & Fee',
                fields: [
                    { key: 'pnl', label: 'Realized PnL', format: (v) => v ? '$' + formatNumber(v) : '--', className: (v) => v >= 0 ? 'profit' : 'loss' },
                    { key: 'fee', label: 'Fee', format: (v) => '$' + formatNumber(Math.abs(v)) },
                ],
            },
            {
                name: 'Raw Data',
                fields: [
                    { key: 'order_id', label: 'Order ID' },
                    { key: 'created_at', label: 'Created', format: formatDetailDateTime },
                    { key: 'updated_at', label: 'Updated', format: formatDetailDateTime },
                    { key: 'accountName', label: 'Account' },
                ],
            },
        ],
    },
    positionHistory: {
        title: 'Position History Detail',
        groups: [
            {
                name: 'Basic',
                fields: [
                    { key: 'inst_id', label: 'Instrument' },
                    { key: 'pos_side', label: 'Side', format: (v) => v === 'long' ? 'Long' : 'Short' },
                    { key: 'lever', label: 'Leverage', format: (v) => v + 'x' },
                    { key: 'mgn_mode', label: 'Margin Mode', format: (v) => v === 'cross' ? 'Cross' : 'Isolated' },
                ],
            },
            {
                name: 'Price',
                fields: [
                    { key: 'open_avg_px', label: 'Entry Price', format: formatPrice },
                    { key: 'close_avg_px', label: 'Close Price', format: formatPrice },
                ],
            },
            {
                name: 'Size',
                fields: [
                    { key: 'open_max_pos', label: 'Max Position' },
                    { key: 'close_total_pos', label: 'Closed Total' },
                ],
            },
            {
                name: 'PnL',
                fields: [
                    { key: 'pnl', label: 'Closed PnL', format: (v) => '$' + formatNumber(v), className: (v) => v >= 0 ? 'profit' : 'loss' },
                    { key: 'pnl_ratio', label: 'PnL Ratio', format: (v) => (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + '%', className: (v) => v >= 0 ? 'profit' : 'loss' },
                    { key: 'realized_pnl', label: 'Realized PnL', format: (v) => '$' + formatNumber(v), className: (v) => v >= 0 ? 'profit' : 'loss' },
                ],
            },
            {
                name: 'Fees',
                fields: [
                    { key: 'fee', label: 'Trading Fee', format: (v) => '$' + formatNumber(Math.abs(v)) },
                    { key: 'funding_fee', label: 'Funding Fee', format: (v) => '$' + formatNumber(v), className: (v) => v >= 0 ? 'profit' : 'loss' },
                    { key: 'liq_penalty', label: 'Liquidation Penalty', format: (v) => v ? '$' + formatNumber(v) : '--' },
                ],
            },
            {
                name: 'Time',
                fields: [
                    { key: 'created_at', label: 'Open Time', format: formatDetailDateTime },
                    { key: 'updated_at', label: 'Close Time', format: formatDetailDateTime },
                    { key: 'ccy', label: 'Settlement Currency' },
                ],
            },
        ],
    },
    bill: {
        title: 'Bill Detail',
        groups: [
            {
                name: 'Basic',
                fields: [
                    { key: 'inst_id', label: 'Instrument', format: (v) => v || '--' },
                    { key: 'ccy', label: 'Currency' },
                    { key: 'bill_type', label: 'Type', format: formatDetailBillType },
                    { key: 'sub_type', label: 'Sub Type', format: formatDetailBillSubType },
                    { key: 'exec_type', label: 'Exec Type', format: (v) => v === 'T' ? 'Taker' : v === 'M' ? 'Maker' : '--' },
                ],
            },
            {
                name: 'Amount',
                fields: [
                    { key: 'sz', label: 'Size', format: (v) => v || '--' },
                    { key: 'px', label: 'Price', format: (v) => v ? formatPrice(v) : '--' },
                    { key: 'pnl', label: 'PnL', format: (v) => v ? '$' + formatNumber(v) : '--', className: (v) => v >= 0 ? 'profit' : 'loss' },
                    { key: 'fee', label: 'Fee', format: (v) => v ? '$' + formatNumber(v) : '--' },
                    { key: 'interest', label: 'Interest', format: (v) => v ? '$' + formatNumber(v) : '--' },
                ],
            },
            {
                name: 'Balance',
                fields: [
                    { key: 'bal_chg', label: 'Balance Change', format: (v) => (v >= 0 ? '+' : '') + formatNumber(v), className: (v) => v >= 0 ? 'profit' : 'loss' },
                    { key: 'bal', label: 'Balance After', format: (v) => '$' + formatNumber(v) },
                ],
            },
            {
                name: 'Transfer',
                fields: [
                    { key: 'from_account', label: 'From', format: formatDetailAccountType },
                    { key: 'to_account', label: 'To', format: formatDetailAccountType },
                    { key: 'notes', label: 'Notes', format: (v) => v || '--' },
                ],
            },
            {
                name: 'Raw Data',
                fields: [
                    { key: 'bill_id', label: 'Bill ID' },
                    { key: 'timestamp', label: 'Time', format: formatDetailDateTime },
                    { key: 'accountName', label: 'Account' },
                ],
            },
        ],
    },
};

/**
 * 详情弹窗格式化辅助函数
 */
function formatDetailDateTime(val) {
    if (!val) return '--';
    const d = typeof val === 'string' ? new Date(val) : val;
    return d.toLocaleString('zh-CN');
}

function formatDetailPosSide(val) {
    const map = { 'long': 'Long', 'short': 'Short', 'net': 'Net' };
    return map[val] || val || '--';
}

function formatDetailOrderType(val) {
    const map = { 'market': 'Market', 'limit': 'Limit', 'post_only': 'Post Only', 'fok': 'FOK', 'ioc': 'IOC' };
    return map[val] || val || '--';
}

function formatDetailOrderState(val) {
    const map = { 'live': 'Live', 'partially_filled': 'Partial', 'filled': 'Filled', 'canceled': 'Canceled' };
    return map[val] || val || '--';
}

function formatDetailBillType(val) {
    const map = { '1': 'Transfer', '2': 'Trade', '3': 'Delivery', '4': 'ADL', '5': 'Liquidation', '6': 'Margin Transfer', '7': 'Interest', '8': 'Funding Fee', '9': 'ADL', '22': 'Rebate' };
    return map[val] || val || '--';
}

function formatDetailBillSubType(val) {
    const map = {
        '1': 'Buy', '2': 'Sell', '3': 'Open Long', '4': 'Open Short', '5': 'Close Long', '6': 'Close Short',
        '100': 'Fee Deduct', '101': 'Fee Rebate', '102': 'Maker Rebate', '103': 'Taker Fee', '104': 'Maker Fee',
        '173': 'Funding Paid', '174': 'Funding Received',
    };
    return map[val] || val || '--';
}

function formatDetailAccountType(val) {
    const map = { '6': 'Funding', '18': 'Trading' };
    return map[val] || val || '--';
}

/**
 * 打开详情弹窗
 */
function showDetailModal(type, data) {
    const config = DETAIL_FIELD_CONFIG[type];
    if (!config) return;

    const overlay = document.getElementById('detail-modal-overlay');
    const modal = document.getElementById('detail-modal');
    const title = document.getElementById('detail-modal-title');
    const body = document.getElementById('detail-modal-body');

    title.textContent = config.title;

    // 生成内容
    let html = '';
    for (const group of config.groups) {
        // 检查该组是否有任何有效数据
        const hasData = group.fields.some(f => {
            const val = data[f.key];
            return val !== undefined && val !== null && val !== '';
        });
        if (!hasData) continue;

        html += `<div class="field-group">`;
        html += `<div class="field-group-title">${group.name}</div>`;
        
        for (const field of group.fields) {
            const rawVal = data[field.key];
            if (rawVal === undefined || rawVal === null) continue;

            const displayVal = field.format ? field.format(rawVal) : rawVal;
            const className = field.className ? field.className(rawVal) : '';

            html += `
                <div class="field-row">
                    <span class="field-key">${field.label}</span>
                    <span class="field-value ${className}">${displayVal}</span>
                </div>
            `;
        }
        
        html += `</div>`;
    }

    body.innerHTML = html;

    // 显示弹窗
    overlay.classList.add('active');
    modal.classList.add('active');

    // ESC 关闭
    document.addEventListener('keydown', handleModalEsc);
}

/**
 * 关闭详情弹窗
 */
function closeDetailModal() {
    const overlay = document.getElementById('detail-modal-overlay');
    const modal = document.getElementById('detail-modal');
    
    overlay.classList.remove('active');
    modal.classList.remove('active');

    document.removeEventListener('keydown', handleModalEsc);
}

function handleModalEsc(e) {
    if (e.key === 'Escape') {
        closeDetailModal();
    }
}

/**
 * 生成详情按钮 HTML
 */
function detailBtnHtml(type, data) {
    const jsonData = JSON.stringify(data).replace(/"/g, '&quot;');
    return `
        <button class="detail-btn px-2 py-1 text-xs text-text-muted hover:text-accent hover:bg-accent/10 rounded transition-all"
                onclick="event.stopPropagation(); showDetailModal('${type}', JSON.parse(this.dataset.detail))"
                data-detail="${jsonData}">
            Detail
        </button>
    `;
}

// 启动应用
setupThemeToggle();
init();
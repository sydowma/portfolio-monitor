/**
 * OKX 多账户 Dashboard 前端逻辑
 */

// 状态管理
const state = {
    accounts: [],
    currentAccountId: null, // null 表示显示全部
    balances: {},           // accountId -> balance
    positions: {},          // accountId -> positions[]
    pendingOrders: {},      // accountId -> pendingOrders[]
    wsConnected: false,
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
    positionsTable: document.getElementById('positions-table'),
    positionCount: document.getElementById('position-count'),
    noPositions: document.getElementById('no-positions'),
    // 资产
    assetsTable: document.getElementById('assets-table'),
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
};

// WebSocket 连接
let ws = null;

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
    document.getElementById('order-start').value = formatDateTimeLocal(weekAgo);
    document.getElementById('order-end').value = formatDateTimeLocal(now);
    document.getElementById('bill-start').value = formatDateTimeLocal(weekAgo);
    document.getElementById('bill-end').value = formatDateTimeLocal(now);
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
        setTimeout(connectWebSocket, 3000);
    };

    ws.onerror = (err) => {
        console.error('WebSocket error:', err);
    };

    ws.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            handleWsMessage(msg);
        } catch (err) {
            console.error('Failed to parse WS message:', err);
        }
    };

    // 心跳
    setInterval(() => {
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
            break;

        case 'positions':
            state.positions[msg.account_id] = msg.data;
            if (state.currentAccountId === null || state.currentAccountId === msg.account_id) {
                renderPositionsTable();
            }
            break;

        case 'pending_orders':
            state.pendingOrders[msg.account_id] = msg.data;
            if (state.currentAccountId === null || state.currentAccountId === msg.account_id) {
                // 如果当前在在途订单页，则刷新表格
                if (getCurrentTab() === 'pending-orders') {
                    renderPendingOrdersTable();
                }
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
        <button onclick="selectAccount(null)" class="account-btn w-full text-left px-4 py-3 rounded-xl text-sm transition-all ${state.currentAccountId === null ? 'bg-accent text-white' : 'hover:bg-glass-hover text-text-primary'}">
            <div class="flex items-center justify-between">
                <span class="flex items-center gap-2">
                    <span class="text-base">📊</span>
                    <span>全部账户</span>
                </span>
                <span class="text-xs ${state.currentAccountId === null ? 'text-white/70' : 'text-text-muted'} px-2 py-0.5 ${state.currentAccountId === null ? 'bg-white/20' : 'bg-ios-elevated'} rounded-full">${state.accounts.length}</span>
            </div>
        </button>
    `;

    for (const account of state.accounts) {
        const isActive = state.currentAccountId === account.id;
        const balance = state.balances[account.id];
        const equity = balance ? formatNumber(balance.total_equity) : '--';

        html += `
            <button onclick="selectAccount('${account.id}')" class="account-btn w-full text-left px-4 py-3 rounded-xl text-sm transition-all ${isActive ? 'bg-accent text-white' : 'hover:bg-glass-hover text-text-primary'}">
                <div class="flex items-center gap-2">
                    <span class="text-base">${account.simulated ? '🎮' : '💰'}</span>
                    <span>${account.name}</span>
                </div>
                <div class="text-xs ${isActive ? 'text-white/70' : 'text-text-muted'} font-mono mt-1.5 ml-6">$${equity}</div>
            </button>
        `;
    }

    elements.accountList.innerHTML = html;
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

    // 检查当前 tab，如果在订单或账单页，需要重新加载数据
    const currentTab = getCurrentTab();
    if (currentTab === 'pending-orders') {
        renderPendingOrdersTable();
    } else if (currentTab === 'orders') {
        loadOrders();
    } else if (currentTab === 'bills') {
        loadBills();
    } else if (currentTab === 'assets') {
        renderAssetsTable();
    }
}

/**
 * 获取当前激活的 tab
 */
function getCurrentTab() {
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

    // 同时更新账户列表中的权益显示
    renderAccountList();
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
    if (state.currentAccountId === null) {
        // 显示汇总
        let totalEquity = 0;
        let totalAvailable = 0;
        let totalMargin = 0;
        let totalPnl = 0;

        for (const accountId in state.balances) {
            const balance = state.balances[accountId];
            totalEquity += balance.total_equity || 0;
            totalAvailable += balance.available || 0;
            totalMargin += balance.margin_used || 0;
            totalPnl += balance.unrealized_pnl || 0;
        }

        elements.accountEquity.textContent = '$' + formatNumber(totalEquity);
        elements.accountAvailable.textContent = '$' + formatNumber(totalAvailable);
        elements.accountMargin.textContent = '$' + formatNumber(totalMargin);

        const pnlText = (totalPnl >= 0 ? '+' : '') + formatNumber(totalPnl);
        elements.accountPnl.textContent = '$' + pnlText;
        elements.accountPnl.className = `text-2xl font-mono font-semibold ${totalPnl >= 0 ? 'text-profit' : 'text-loss'}`;
    } else {
        const balance = state.balances[state.currentAccountId];
        if (balance) {
            elements.accountEquity.textContent = '$' + formatNumber(balance.total_equity);
            elements.accountAvailable.textContent = '$' + formatNumber(balance.available);
            elements.accountMargin.textContent = '$' + formatNumber(balance.margin_used);

            const pnl = balance.unrealized_pnl || 0;
            const pnlText = (pnl >= 0 ? '+' : '') + formatNumber(pnl);
            elements.accountPnl.textContent = '$' + pnlText;
            elements.accountPnl.className = `text-2xl font-mono font-semibold ${pnl >= 0 ? 'text-profit' : 'text-loss'}`;
        } else {
            elements.accountEquity.textContent = '--';
            elements.accountAvailable.textContent = '--';
            elements.accountMargin.textContent = '--';
            elements.accountPnl.textContent = '--';
            elements.accountPnl.className = 'text-2xl font-mono font-semibold';
        }
    }
}

/**
 * 渲染仓位表格
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
        positions = state.positions[state.currentAccountId] || [];
    }

    elements.positionCount.textContent = `${positions.length} 个仓位`;

    if (positions.length === 0) {
        elements.positionsTable.innerHTML = '';
        elements.noPositions.classList.remove('hidden');
        return;
    }

    elements.noPositions.classList.add('hidden');

    let html = '';
    for (const pos of positions) {
        const isLong = pos.pos_side === 'long' || (pos.pos_side === 'net' && pos.pos > 0);
        const directionText = isLong ? '多' : '空';
        const directionClass = isLong ? 'text-profit' : 'text-loss';
        const directionBgClass = isLong ? 'bg-profit/15' : 'bg-loss/15';

        const uplText = (pos.upl >= 0 ? '+' : '') + formatNumber(pos.upl);
        const uplClass = pos.upl >= 0 ? 'text-profit' : 'text-loss';

        const uplRatioText = (pos.upl_ratio * 100).toFixed(2) + '%';
        const uplRatioClass = pos.upl_ratio >= 0 ? 'text-profit' : 'text-loss';

        const showAccountName = state.currentAccountId === null;

        html += `
            <tr class="table-row-hover">
                <td class="px-6 py-4">
                    <div class="font-mono text-sm font-medium">${pos.inst_id}</div>
                    ${showAccountName ? `<div class="text-xs text-text-muted mt-1">${pos.accountName}</div>` : ''}
                </td>
                <td class="px-6 py-4">
                    <span class="px-2.5 py-1 rounded-md text-xs font-medium ${directionClass} ${directionBgClass}">
                        ${directionText}
                    </span>
                </td>
                <td class="px-6 py-4 text-right font-mono text-sm">${Math.abs(pos.pos)}</td>
                <td class="px-6 py-4 text-right font-mono text-sm text-text-muted">${formatPrice(pos.avg_px)}</td>
                <td class="px-6 py-4 text-right font-mono text-sm">${formatPrice(pos.mark_px)}</td>
                <td class="px-6 py-4 text-right font-mono text-sm font-medium ${uplClass}">${uplText}</td>
                <td class="px-6 py-4 text-right font-mono text-sm font-medium ${uplRatioClass}">${uplRatioText}</td>
                <td class="px-6 py-4 text-right font-mono text-sm text-text-muted">${pos.lever}x</td>
            </tr>
        `;
    }

    elements.positionsTable.innerHTML = html;
}

/**
 * 渲染资产表格
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
        elements.assetsTable.innerHTML = '';
        elements.noAssets.classList.remove('hidden');
        return;
    }

    elements.noAssets.classList.add('hidden');

    let html = '';
    for (const asset of assets) {
        const iconUrl = getCryptoIconUrl(asset.ccy);
        const fallbackText = asset.ccy.slice(0, 2);
        
        html += `
            <tr class="table-row-hover">
                <td class="px-6 py-4">
                    <div class="flex items-center gap-3">
                        <div class="w-8 h-8 rounded-full bg-ios-elevated flex items-center justify-center overflow-hidden">
                            <img src="${iconUrl}" 
                                 alt="${asset.ccy}" 
                                 class="w-6 h-6"
                                 onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';"
                            />
                            <span class="text-xs font-semibold hidden items-center justify-center w-full h-full">${fallbackText}</span>
                        </div>
                        <span class="font-medium">${asset.ccy}</span>
                    </div>
                </td>
                <td class="px-6 py-4 text-right font-mono text-sm">${formatAssetNumber(asset.bal)}</td>
                <td class="px-6 py-4 text-right font-mono text-sm text-text-secondary">${formatAssetNumber(asset.avail_bal)}</td>
                <td class="px-6 py-4 text-right font-mono text-sm text-text-muted">${formatAssetNumber(asset.frozen_bal)}</td>
                <td class="px-6 py-4 text-right font-mono text-sm font-medium">${formatNumber(asset.eq)}</td>
            </tr>
        `;
    }

    elements.assetsTable.innerHTML = html;
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
    const viewPositions = document.getElementById('view-positions');
    const viewAssets = document.getElementById('view-assets');
    const viewPendingOrders = document.getElementById('view-pending-orders');
    const viewOrders = document.getElementById('view-orders');
    const viewBills = document.getElementById('view-bills');
    const tabPositions = document.getElementById('tab-positions');
    const tabAssets = document.getElementById('tab-assets');
    const tabPendingOrders = document.getElementById('tab-pending-orders');
    const tabOrders = document.getElementById('tab-orders');
    const tabBills = document.getElementById('tab-bills');

    const inactiveClass = 'tab-btn px-5 py-2 rounded-lg text-sm font-medium text-text-muted hover:text-text-primary hover:bg-glass-hover transition-all';
    const activeClass = 'tab-btn px-5 py-2 rounded-lg text-sm font-medium tab-active transition-all';

    // 隐藏所有视图，重置所有标签
    viewPositions.classList.add('hidden');
    viewAssets.classList.add('hidden');
    viewPendingOrders.classList.add('hidden');
    viewOrders.classList.add('hidden');
    viewBills.classList.add('hidden');
    tabPositions.className = inactiveClass;
    tabAssets.className = inactiveClass;
    tabPendingOrders.className = inactiveClass;
    tabOrders.className = inactiveClass;
    tabBills.className = inactiveClass;

    if (tab === 'positions') {
        viewPositions.classList.remove('hidden');
        tabPositions.className = activeClass;
    } else if (tab === 'assets') {
        viewAssets.classList.remove('hidden');
        tabAssets.className = activeClass;
        renderAssetsTable();
    } else if (tab === 'pending-orders') {
        viewPendingOrders.classList.remove('hidden');
        tabPendingOrders.className = activeClass;
        // 首次切换时加载在途订单
        if (elements.pendingOrdersTable.children.length === 0) {
            loadPendingOrders();
        }
    } else if (tab === 'orders') {
        viewOrders.classList.remove('hidden');
        tabOrders.className = activeClass;
        // 首次切换到订单页时加载订单
        if (elements.ordersTable.children.length === 0) {
            loadOrders();
        }
    } else if (tab === 'bills') {
        viewBills.classList.remove('hidden');
        tabBills.className = activeClass;
        // 首次切换到账单页时加载账单
        if (elements.billsTable.children.length === 0) {
            loadBills();
        }
    }
}

/**
 * 加载在途订单
 */
async function loadPendingOrders() {
    elements.pendingOrdersLoading.classList.remove('hidden');
    elements.noPendingOrders.classList.add('hidden');
    elements.pendingOrdersTable.innerHTML = '';

    try {
        if (state.currentAccountId === null) {
            // 全部账户模式：加载所有账户的在途订单
            await loadAllAccountsPendingOrders();
        } else {
            // 单账户模式
            const resp = await fetch(`/api/accounts/${state.currentAccountId}/pending-orders`);
            const orders = await resp.json();
            state.pendingOrders[state.currentAccountId] = orders;
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
        const stateClass = order.state === 'partially_filled' ? 'bg-accent/20 text-accent' : 'bg-ios-elevated';

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

        html += `
            <tr class="table-row-hover">
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
                    <span class="px-2 py-1 rounded-md text-xs font-medium ${stateClass}">${stateText}</span>
                </td>
            </tr>
        `;
    }

    elements.pendingOrdersTable.innerHTML = html;
}

/**
 * 加载历史订单（支持分页）
 */
async function loadOrders(resetPage = true) {
    if (state.currentAccountId === null) {
        // 全部账户模式暂不支持分页
        await loadAllAccountsOrders();
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

    elements.ordersLoading.classList.remove('hidden');
    elements.noOrders.classList.add('hidden');
    elements.ordersTable.innerHTML = '';
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
    
    elements.ordersPagination.classList.remove('hidden');
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
async function loadAllAccountsOrders() {
    const startInput = document.getElementById('order-start').value;
    const endInput = document.getElementById('order-end').value;

    elements.ordersLoading.classList.remove('hidden');
    elements.noOrders.classList.add('hidden');
    elements.ordersTable.innerHTML = '';
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
async function loadBills(resetPage = true) {
    if (state.currentAccountId === null) {
        // 全部账户模式暂不支持分页
        await loadAllAccountsBills();
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

    elements.billsLoading.classList.remove('hidden');
    elements.noBills.classList.add('hidden');
    elements.billsTable.innerHTML = '';
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
    
    elements.billsPagination.classList.remove('hidden');
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
async function loadAllAccountsBills() {
    const billType = document.getElementById('bill-type').value;
    const startInput = document.getElementById('bill-start').value;
    const endInput = document.getElementById('bill-end').value;

    elements.billsLoading.classList.remove('hidden');
    elements.noBills.classList.add('hidden');
    elements.billsTable.innerHTML = '';
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
        if (bill.exec_type === 'T') {
            execTypeText = 'T';
            execTypeClass = 'text-loss';
        } else if (bill.exec_type === 'M') {
            execTypeText = 'M';
            execTypeClass = 'text-profit';
        }

        html += `
            <tr class="table-row-hover">
                <td class="px-6 py-3.5 text-sm">
                    ${time}
                    ${showAccountName ? `<div class="text-xs text-text-muted mt-1">${bill.accountName}</div>` : ''}
                </td>
                <td class="px-6 py-3.5 text-sm">
                    <span class="px-2 py-1 rounded-md text-xs font-medium bg-ios-elevated">${typeText}</span>
                </td>
                <td class="px-6 py-3.5 text-sm ${subTypeClass}">${subTypeText}</td>
                <td class="px-6 py-3.5 text-center text-sm font-mono font-medium ${execTypeClass}">${execTypeText}</td>
                <td class="px-6 py-3.5 font-mono text-sm">${bill.inst_id || '-'}</td>
                <td class="px-6 py-3.5 text-right font-mono text-sm font-medium ${pnlClass}">${pnlText}</td>
                <td class="px-6 py-3.5 text-right font-mono text-sm text-text-muted">${feeText}</td>
                <td class="px-6 py-3.5 text-right font-mono text-sm font-medium ${balChgClass}">${balChgText}</td>
                <td class="px-6 py-3.5 text-right font-mono text-sm text-text-muted">${formatNumber(bill.bal)}</td>
            </tr>
        `;
    }

    elements.billsTable.innerHTML = html;
}

/**
 * 渲染订单表格
 */
function renderOrdersTable(orders, showAccountName = false) {
    if (orders.length === 0) {
        elements.noOrders.classList.remove('hidden');
        return;
    }

    elements.noOrders.classList.add('hidden');

    let html = '';
    for (const order of orders) {
        const isBuy = order.side === 'buy';
        const sideText = isBuy ? '买入' : '卖出';
        const sideClass = isBuy ? 'text-profit' : 'text-loss';

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

        const pnlText = order.pnl ? ((order.pnl >= 0 ? '+' : '') + formatNumber(order.pnl)) : '-';
        const pnlClass = order.pnl >= 0 ? 'text-profit' : 'text-loss';

        const time = new Date(order.created_at).toLocaleString('zh-CN');

        html += `
            <tr class="table-row-hover">
                <td class="px-6 py-3.5 text-sm">
                    ${time}
                    ${showAccountName ? `<div class="text-xs text-text-muted mt-1">${order.accountName}</div>` : ''}
                </td>
                <td class="px-6 py-3.5 font-mono text-sm font-medium">${order.inst_id}</td>
                <td class="px-6 py-3.5 ${sideClass} text-sm font-medium">${sideText}</td>
                <td class="px-6 py-3.5 text-sm text-text-muted">${typeText}</td>
                <td class="px-6 py-3.5 text-right font-mono text-sm">${order.sz}</td>
                <td class="px-6 py-3.5 text-right font-mono text-sm text-text-muted">${order.avg_px ? formatPrice(order.avg_px) : '-'}</td>
                <td class="px-6 py-3.5 text-right font-mono text-sm font-medium ${pnlClass}">${pnlText}</td>
                <td class="px-6 py-3.5 text-right font-mono text-sm text-text-muted">${formatNumber(Math.abs(order.fee))}</td>
                <td class="px-6 py-3.5 text-sm">
                    <span class="px-2 py-1 rounded-md text-xs font-medium bg-ios-elevated">${stateText}</span>
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

// 启动应用
init();


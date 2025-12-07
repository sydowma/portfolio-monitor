"""
数据模型定义
"""
from datetime import datetime
from typing import Optional
from pydantic import BaseModel


class AccountInfo(BaseModel):
    """账户基本信息"""
    id: str
    name: str
    simulated: bool


class CurrencyAsset(BaseModel):
    """单个币种资产"""
    ccy: str  # 币种
    bal: float  # 余额
    avail_bal: float  # 可用余额
    frozen_bal: float  # 冻结余额
    eq: float  # 币种权益 (USDT 估值)
    eq_usd: float  # USD 估值


class Balance(BaseModel):
    """账户资产"""
    total_equity: float  # 总权益 (USDT)
    available: float  # 可用余额
    frozen: float  # 冻结
    margin_used: float  # 已用保证金
    unrealized_pnl: float  # 未实现盈亏
    assets: list[CurrencyAsset] = []  # 各币种资产明细


class Position(BaseModel):
    """合约仓位"""
    inst_id: str  # 合约ID，如 BTC-USDT-SWAP
    pos_side: str  # 持仓方向: long/short/net
    pos: float  # 持仓数量
    avg_px: float  # 开仓均价
    mark_px: float  # 标记价格
    upl: float  # 未实现盈亏 (USDT)
    upl_ratio: float  # 未实现盈亏比例
    margin: float  # 保证金
    lever: int  # 杠杆倍数
    liq_px: Optional[float] = None  # 预估强平价
    created_at: Optional[datetime] = None


class Order(BaseModel):
    """历史订单"""
    order_id: str
    inst_id: str
    side: str  # buy/sell
    pos_side: str  # long/short
    order_type: str  # market/limit
    sz: float  # 数量
    px: Optional[float] = None  # 价格
    avg_px: Optional[float] = None  # 成交均价
    state: str  # filled/canceled/...
    pnl: float  # 盈亏
    fee: float  # 手续费
    created_at: datetime
    updated_at: datetime


class Bill(BaseModel):
    """账单记录"""
    bill_id: str
    inst_id: str  # 合约 ID，可能为空
    ccy: str  # 币种
    bill_type: str  # 账单类型: 1-划转 2-交易 8-资金费 等
    sub_type: str  # 子类型
    pnl: float  # 收益金额
    fee: float  # 手续费
    bal: float  # 账户余额
    bal_chg: float  # 余额变动
    sz: float  # 数量
    px: Optional[float] = None  # 价格
    exec_type: Optional[str] = None  # 流动性方向: T=Taker, M=Maker
    from_account: Optional[str] = None  # 转出账户: 6=资金账户, 18=交易账户
    to_account: Optional[str] = None  # 转入账户: 6=资金账户, 18=交易账户
    notes: Optional[str] = None  # 备注
    interest: Optional[float] = None  # 利息
    timestamp: datetime


class AccountSummary(BaseModel):
    """账户汇总信息"""
    account: AccountInfo
    balance: Optional[Balance] = None
    positions: list[Position] = []
    error: Optional[str] = None


class AllAccountsSummary(BaseModel):
    """所有账户汇总"""
    total_equity: float  # 所有账户总权益
    total_unrealized_pnl: float  # 所有账户总未实现盈亏
    accounts: list[AccountSummary]
    updated_at: datetime


class PendingOrder(BaseModel):
    """在途订单（未成交/部分成交的挂单）"""
    order_id: str
    inst_id: str
    side: str  # buy/sell
    pos_side: str  # long/short/net
    order_type: str  # market/limit/post_only/fok/ioc
    sz: float  # 委托数量
    px: Optional[float] = None  # 委托价格
    fill_sz: float = 0  # 已成交数量
    avg_px: Optional[float] = None  # 成交均价
    state: str  # live/partially_filled
    lever: int = 1  # 杠杆倍数
    # 止盈止损
    sl_trigger_px: Optional[float] = None  # 止损触发价
    sl_ord_px: Optional[float] = None  # 止损委托价 (-1 表示市价)
    tp_trigger_px: Optional[float] = None  # 止盈触发价
    tp_ord_px: Optional[float] = None  # 止盈委托价 (-1 表示市价)
    created_at: datetime
    updated_at: datetime


class PaginatedOrders(BaseModel):
    """分页订单响应"""
    items: list[Order]
    has_more: bool
    last_id: Optional[str] = None  # 用于请求下一页


class PaginatedBills(BaseModel):
    """分页账单响应"""
    items: list[Bill]
    has_more: bool
    last_id: Optional[str] = None  # 用于请求下一页


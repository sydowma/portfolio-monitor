"""
REST API 路由
提供账户列表、资产、仓位、历史订单等接口
"""
import asyncio
from datetime import datetime, timezone, timedelta
from typing import Optional
from collections import defaultdict
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from config import ACCOUNTS, get_account
from models import AccountInfo, Balance, Position, Order, Bill, AccountSummary, PaginatedOrders, PaginatedBills, PendingOrder, PositionHistory, PaginatedPositionHistory
from okx import OKXRestClient


router = APIRouter(prefix="/api", tags=["api"])


class EquityCurvePoint(BaseModel):
    """资产曲线数据点"""
    timestamp: str
    balance: float


class EquityCurveResponse(BaseModel):
    """资产曲线响应"""
    points: list[EquityCurvePoint]
    start_balance: Optional[float] = None
    end_balance: Optional[float] = None
    total_points: int = 0


class CancelOrderRequest(BaseModel):
    """取消订单请求"""
    inst_id: str
    order_id: str


class CancelOrderResponse(BaseModel):
    """取消订单响应"""
    success: bool
    inst_id: str
    order_id: str
    okx_s_code: Optional[str] = None
    okx_s_msg: Optional[str] = None


@router.get("/accounts", response_model=list[AccountInfo])
async def list_accounts():
    """获取所有账户列表"""
    return [
        AccountInfo(id=acc.id, name=acc.name, simulated=acc.simulated)
        for acc in ACCOUNTS
    ]


@router.get("/accounts/{account_id}/balance", response_model=Balance)
async def get_balance(account_id: str):
    """获取指定账户的资产"""
    account = get_account(account_id)
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")

    client = OKXRestClient(account)
    try:
        return await client.get_balance()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        await client.close()


@router.get("/accounts/{account_id}/positions", response_model=list[Position])
async def get_positions(account_id: str):
    """获取指定账户的仓位"""
    account = get_account(account_id)
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")

    client = OKXRestClient(account)
    try:
        return await client.get_positions()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        await client.close()


@router.get("/accounts/{account_id}/pending-orders", response_model=list[PendingOrder])
async def get_pending_orders(account_id: str):
    """获取指定账户的在途订单（未成交/部分成交）"""
    account = get_account(account_id)
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")

    client = OKXRestClient(account)
    try:
        return await client.get_pending_orders()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        await client.close()


@router.post("/accounts/{account_id}/cancel-order", response_model=CancelOrderResponse)
async def cancel_order(account_id: str, req: CancelOrderRequest):
    """取消指定账户的订单（在途订单）"""
    account = get_account(account_id)
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")

    client = OKXRestClient(account)
    try:
        return await client.cancel_order(inst_id=req.inst_id, order_id=req.order_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        await client.close()


@router.get("/accounts/{account_id}/orders", response_model=PaginatedOrders)
async def get_orders(
    account_id: str,
    start: Optional[str] = Query(None, description="开始时间 ISO 格式"),
    end: Optional[str] = Query(None, description="结束时间 ISO 格式"),
    after: Optional[str] = Query(None, description="分页游标，上一页最后一条的 order_id"),
    limit: int = Query(50, ge=1, le=100),
):
    """获取指定账户的历史订单（分页）"""
    account = get_account(account_id)
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")

    start_time = None
    end_time = None

    if start:
        try:
            start_time = datetime.fromisoformat(start.replace("Z", "+00:00"))
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid start time format")

    if end:
        try:
            end_time = datetime.fromisoformat(end.replace("Z", "+00:00"))
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid end time format")

    client = OKXRestClient(account)
    try:
        orders, has_more, last_id = await client.get_orders_history(
            start_time, end_time, after, limit
        )
        return PaginatedOrders(items=orders, has_more=has_more, last_id=last_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        await client.close()


@router.get("/accounts/{account_id}/bills", response_model=PaginatedBills)
async def get_bills(
    account_id: str,
    bill_type: Optional[str] = Query(None, description="账单类型: 1-划转 2-交易 8-资金费"),
    inst_id: Optional[str] = Query(None, description="合约 ID，如 BTC-USDT-SWAP"),
    start: Optional[str] = Query(None, description="开始时间 ISO 格式"),
    end: Optional[str] = Query(None, description="结束时间 ISO 格式"),
    after: Optional[str] = Query(None, description="分页游标，上一页最后一条的 bill_id"),
    limit: int = Query(50, ge=1, le=100),
):
    """获取指定账户的账单流水（分页）"""
    account = get_account(account_id)
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")

    start_time = None
    end_time = None

    if start:
        try:
            start_time = datetime.fromisoformat(start.replace("Z", "+00:00"))
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid start time format")

    if end:
        try:
            end_time = datetime.fromisoformat(end.replace("Z", "+00:00"))
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid end time format")

    client = OKXRestClient(account)
    try:
        bills, has_more, last_id = await client.get_bills(
            bill_type, inst_id, start_time, end_time, after, limit
        )
        return PaginatedBills(items=bills, has_more=has_more, last_id=last_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        await client.close()


@router.get("/accounts/{account_id}/positions-history", response_model=PaginatedPositionHistory)
async def get_positions_history(
    account_id: str,
    inst_id: Optional[str] = Query(None, description="合约 ID，如 BTC-USDT-SWAP"),
    pos_side: Optional[str] = Query(None, description="持仓方向: long/short (前端过滤)"),
    start: Optional[str] = Query(None, description="开始时间 ISO 格式"),
    end: Optional[str] = Query(None, description="结束时间 ISO 格式"),
    after: Optional[str] = Query(None, description="分页游标"),
    limit: int = Query(50, ge=1, le=100),
):
    """获取指定账户的历史仓位（已平仓）"""
    account = get_account(account_id)
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")

    start_time = None
    end_time = None

    if start:
        try:
            start_time = datetime.fromisoformat(start.replace("Z", "+00:00"))
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid start time format")

    if end:
        try:
            end_time = datetime.fromisoformat(end.replace("Z", "+00:00"))
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid end time format")

    client = OKXRestClient(account)
    try:
        positions, has_more, last_id = await client.get_positions_history(
            inst_id, start_time, end_time, after, limit
        )
        # OKX API 不支持按方向筛选，在后端过滤
        if pos_side:
            positions = [p for p in positions if p.pos_side == pos_side]
        return PaginatedPositionHistory(items=positions, has_more=has_more, last_id=last_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        await client.close()


@router.get("/accounts/{account_id}/equity-curve", response_model=EquityCurveResponse)
async def get_equity_curve(
    account_id: str,
    days: int = Query(30, ge=1, le=90, description="查询天数，最多90天"),
    interval: str = Query("raw", description="聚合间隔: raw/hourly/daily"),
):
    """
    获取账户资产曲线数据
    基于账单流水的 bal 字段反推历史资产
    """
    account = get_account(account_id)
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")

    client = OKXRestClient(account)
    try:
        end_time = datetime.now(timezone.utc)
        start_time = end_time - timedelta(days=days)

        # 收集所有 USDT 账单
        all_bills = []
        after = None
        max_pages = 50

        for _ in range(max_pages):
            bills, has_more, last_id = await client.get_bills(
                bill_type=None,
                inst_id=None,
                start_time=start_time,
                end_time=end_time,
                after=after,
                limit=100,
            )
            # 只保留 USDT 账单
            usdt_bills = [b for b in bills if b.ccy == "USDT"]
            all_bills.extend(usdt_bills)

            if not has_more or not last_id:
                break
            after = last_id

        if not all_bills:
            return EquityCurveResponse(points=[], total_points=0)

        # 按时间排序（从早到晚）
        all_bills.sort(key=lambda b: b.timestamp)

        # 构建数据点
        points = []
        for bill in all_bills:
            points.append(EquityCurvePoint(
                timestamp=bill.timestamp.isoformat(),
                balance=bill.bal,
            ))

        # 按间隔聚合
        if interval == "hourly":
            points = _aggregate_by_hour(points)
        elif interval == "daily":
            points = _aggregate_by_day(points)

        return EquityCurveResponse(
            points=points,
            start_balance=points[0].balance if points else None,
            end_balance=points[-1].balance if points else None,
            total_points=len(points),
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        await client.close()


def _aggregate_by_hour(points: list[EquityCurvePoint]) -> list[EquityCurvePoint]:
    """按小时聚合，取每小时最后一个点"""
    if not points:
        return []
    
    hourly = {}
    for p in points:
        # 截取到小时
        hour_key = p.timestamp[:13]  # "2025-12-07T09"
        hourly[hour_key] = p
    
    return list(hourly.values())


def _aggregate_by_day(points: list[EquityCurvePoint]) -> list[EquityCurvePoint]:
    """按天聚合，取每天最后一个点"""
    if not points:
        return []
    
    daily = {}
    for p in points:
        # 截取到天
        day_key = p.timestamp[:10]  # "2025-12-07"
        daily[day_key] = p
    
    return list(daily.values())


@router.get("/summary", response_model=list[AccountSummary])
async def get_all_accounts_summary():
    """获取所有账户的汇总信息 (资产 + 仓位)"""
    # 有限并发：避免账户数增长时串行慢，也避免对 OKX 造成尖峰压力
    semaphore = asyncio.Semaphore(5)

    async def fetch_one(account) -> AccountSummary:
        async with semaphore:
            client = OKXRestClient(account)
            try:
                balance, positions = await asyncio.gather(
                    client.get_balance(),
                    client.get_positions(),
                )
                return AccountSummary(
                    account=AccountInfo(
                        id=account.id,
                        name=account.name,
                        simulated=account.simulated,
                    ),
                    balance=balance,
                    positions=positions,
                )
            except Exception as e:
                return AccountSummary(
                    account=AccountInfo(
                        id=account.id,
                        name=account.name,
                        simulated=account.simulated,
                    ),
                    error=str(e),
                )
            finally:
                await client.close()

    return await asyncio.gather(*(fetch_one(account) for account in ACCOUNTS))


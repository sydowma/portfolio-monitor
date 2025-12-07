"""
REST API 路由
提供账户列表、资产、仓位、历史订单等接口
"""
from datetime import datetime, timezone
from typing import Optional
from fastapi import APIRouter, HTTPException, Query

from config import ACCOUNTS, get_account
from models import AccountInfo, Balance, Position, Order, Bill, AccountSummary, PaginatedOrders, PaginatedBills, PendingOrder
from okx import OKXRestClient


router = APIRouter(prefix="/api", tags=["api"])


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


@router.get("/summary", response_model=list[AccountSummary])
async def get_all_accounts_summary():
    """获取所有账户的汇总信息 (资产 + 仓位)"""
    summaries = []

    for account in ACCOUNTS:
        client = OKXRestClient(account)
        try:
            balance = await client.get_balance()
            positions = await client.get_positions()
            summaries.append(AccountSummary(
                account=AccountInfo(
                    id=account.id,
                    name=account.name,
                    simulated=account.simulated,
                ),
                balance=balance,
                positions=positions,
            ))
        except Exception as e:
            summaries.append(AccountSummary(
                account=AccountInfo(
                    id=account.id,
                    name=account.name,
                    simulated=account.simulated,
                ),
                error=str(e),
            ))
        finally:
            await client.close()

    return summaries


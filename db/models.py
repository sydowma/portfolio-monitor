"""
数据库 CRUD 操作
"""
import time
from typing import Optional
from dataclasses import dataclass
import aiosqlite

from .database import get_db


@dataclass
class CurrencySnapshot:
    """币种快照数据"""
    ccy: str
    bal: float
    avail_bal: float
    frozen_bal: float
    eq: float
    eq_usd: float


@dataclass
class BalanceSnapshot:
    """资产快照数据"""
    account_id: str
    timestamp: int  # 毫秒级时间戳
    total_equity: float
    available: float
    frozen: float
    margin_used: float
    unrealized_pnl: float
    currencies: list[CurrencySnapshot]


async def save_snapshot(snapshot: BalanceSnapshot) -> int:
    """
    保存资产快照到数据库

    Returns:
        快照 ID
    """
    db = await get_db()
    now = int(time.time() * 1000)

    # 插入主记录
    cursor = await db.execute(
        """
        INSERT OR REPLACE INTO balance_snapshots
        (account_id, timestamp, total_equity, available, frozen, margin_used, unrealized_pnl, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            snapshot.account_id,
            snapshot.timestamp,
            snapshot.total_equity,
            snapshot.available,
            snapshot.frozen,
            snapshot.margin_used,
            snapshot.unrealized_pnl,
            now,
        ),
    )
    snapshot_id = cursor.lastrowid

    # 如果是更新操作（已存在记录），需要先删除旧的币种记录
    if cursor.lastrowid == 0:
        # 获取已存在记录的 ID
        async with db.execute(
            "SELECT id FROM balance_snapshots WHERE account_id = ? AND timestamp = ?",
            (snapshot.account_id, snapshot.timestamp),
        ) as cur:
            row = await cur.fetchone()
            if row:
                snapshot_id = row["id"]
                await db.execute(
                    "DELETE FROM currency_snapshots WHERE snapshot_id = ?",
                    (snapshot_id,),
                )

    # 插入币种详情
    for currency in snapshot.currencies:
        await db.execute(
            """
            INSERT INTO currency_snapshots
            (snapshot_id, ccy, bal, avail_bal, frozen_bal, eq, eq_usd)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                snapshot_id,
                currency.ccy,
                currency.bal,
                currency.avail_bal,
                currency.frozen_bal,
                currency.eq,
                currency.eq_usd,
            ),
        )

    await db.commit()
    return snapshot_id


async def get_snapshots(
    account_id: str,
    start_time: int,
    end_time: int,
) -> list[dict]:
    """
    获取账户的快照数据

    Args:
        account_id: 账户 ID
        start_time: 开始时间戳（毫秒）
        end_time: 结束时间戳（毫秒）

    Returns:
        快照记录列表
    """
    db = await get_db()

    async with db.execute(
        """
        SELECT id, account_id, timestamp, total_equity, available, frozen,
               margin_used, unrealized_pnl
        FROM balance_snapshots
        WHERE account_id = ? AND timestamp >= ? AND timestamp <= ?
        ORDER BY timestamp ASC
        """,
        (account_id, start_time, end_time),
    ) as cursor:
        rows = await cursor.fetchall()

    return [dict(row) for row in rows]


async def get_snapshots_with_currencies(
    account_id: str,
    start_time: int,
    end_time: int,
) -> list[dict]:
    """
    获取账户的快照数据（包含币种详情）

    Args:
        account_id: 账户 ID
        start_time: 开始时间戳（毫秒）
        end_time: 结束时间戳（毫秒）

    Returns:
        快照记录列表（包含 currencies 字段）
    """
    db = await get_db()

    # 获取主记录
    snapshots = await get_snapshots(account_id, start_time, end_time)

    # 获取每条记录的币种详情
    for snapshot in snapshots:
        async with db.execute(
            """
            SELECT ccy, bal, avail_bal, frozen_bal, eq, eq_usd
            FROM currency_snapshots
            WHERE snapshot_id = ?
            ORDER BY eq_usd DESC
            """,
            (snapshot["id"],),
        ) as cursor:
            snapshot["currencies"] = [dict(row) for row in await cursor.fetchall()]

    return snapshots


async def cleanup_old_snapshots(retention_days: int = 90) -> int:
    """
    清理过期快照数据

    Args:
        retention_days: 保留天数

    Returns:
        删除的记录数
    """
    db = await get_db()
    cutoff_time = int(time.time() * 1000) - (retention_days * 24 * 60 * 60 * 1000)

    cursor = await db.execute(
        "DELETE FROM balance_snapshots WHERE timestamp < ?",
        (cutoff_time,),
    )

    deleted_count = cursor.rowcount
    await db.commit()

    return deleted_count


async def get_snapshot_count(account_id: Optional[str] = None) -> int:
    """
    获取快照数量

    Args:
        account_id: 可选，指定账户 ID

    Returns:
        快照数量
    """
    db = await get_db()

    if account_id:
        async with db.execute(
            "SELECT COUNT(*) as count FROM balance_snapshots WHERE account_id = ?",
            (account_id,),
        ) as cursor:
            row = await cursor.fetchone()
    else:
        async with db.execute(
            "SELECT COUNT(*) as count FROM balance_snapshots"
        ) as cursor:
            row = await cursor.fetchone()

    return row["count"] if row else 0

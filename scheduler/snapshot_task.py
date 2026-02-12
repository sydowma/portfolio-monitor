"""
资产快照定时任务
"""
import os
import asyncio
import time
from datetime import datetime, timezone
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

from config import ACCOUNTS
from okx.rest_client import OKXRestClient
from db import (
    BalanceSnapshot,
    CurrencySnapshot,
    save_snapshot,
    cleanup_old_snapshots,
)

# 调度器实例
_scheduler: AsyncIOScheduler | None = None

# 并发限制：同时获取的账户数
MAX_CONCURRENT = 5

# 数据保留天数（从环境变量读取，默认 90 天）
RETENTION_DAYS = int(os.getenv("SNAPSHOT_RETENTION_DAYS", "90"))


def _align_to_minute(ts_ms: int) -> int:
    """将时间戳对齐到分钟（秒级置零，转为毫秒）"""
    ts_sec = ts_ms // 1000
    aligned_sec = (ts_sec // 60) * 60
    return aligned_sec * 1000


async def _collect_snapshot(account_id: str) -> bool:
    """
    收集单个账户的快照

    Returns:
        是否成功
    """
    from config import get_account

    account = get_account(account_id)
    if not account:
        print(f"[Snapshot] Account {account_id} not found")
        return False

    client = OKXRestClient(account)
    try:
        balance = await client.get_balance()

        # 对齐到分钟
        now_ms = int(time.time() * 1000)
        aligned_ts = _align_to_minute(now_ms)

        # 构建快照数据
        currencies = [
            CurrencySnapshot(
                ccy=asset.ccy,
                bal=asset.bal,
                avail_bal=asset.avail_bal,
                frozen_bal=asset.frozen_bal,
                eq=asset.eq,
                eq_usd=asset.eq_usd,
            )
            for asset in balance.assets
        ]

        snapshot = BalanceSnapshot(
            account_id=account_id,
            timestamp=aligned_ts,
            total_equity=balance.total_equity,
            available=balance.available,
            frozen=balance.frozen,
            margin_used=balance.margin_used,
            unrealized_pnl=balance.unrealized_pnl,
            currencies=currencies,
        )

        await save_snapshot(snapshot)
        return True

    except Exception as e:
        print(f"[Snapshot] Failed to collect snapshot for account {account_id}: {e}")
        return False
    finally:
        await client.close()


async def collect_all_snapshots():
    """收集所有账户的快照"""
    if not ACCOUNTS:
        print("[Snapshot] No accounts configured")
        return

    print(f"[Snapshot] Starting collection for {len(ACCOUNTS)} accounts...")

    # 使用信号量限制并发
    semaphore = asyncio.Semaphore(MAX_CONCURRENT)

    async def collect_with_limit(account_id: str):
        async with semaphore:
            return await _collect_snapshot(account_id)

    # 并发收集所有账户
    tasks = [collect_with_limit(acc.id) for acc in ACCOUNTS]
    results = await asyncio.gather(*tasks)

    success_count = sum(1 for r in results if r)
    print(f"[Snapshot] Collection completed: {success_count}/{len(ACCOUNTS)} successful")


async def cleanup_snapshots():
    """清理过期快照"""
    try:
        deleted = await cleanup_old_snapshots(RETENTION_DAYS)
        if deleted > 0:
            print(f"[Snapshot] Cleanup completed: deleted {deleted} old snapshots")
    except Exception as e:
        print(f"[Snapshot] Cleanup failed: {e}")


def start_scheduler():
    """启动定时任务调度器"""
    global _scheduler

    if _scheduler is not None:
        print("[Scheduler] Already running")
        return

    _scheduler = AsyncIOScheduler()

    # 每分钟整点执行快照收集
    _scheduler.add_job(
        collect_all_snapshots,
        trigger=CronTrigger(minute="*"),
        id="snapshot_collector",
        name="Collect balance snapshots",
        misfire_grace_time=30,
    )

    # 每周日凌晨 3 点执行数据清理
    _scheduler.add_job(
        cleanup_snapshots,
        trigger=CronTrigger(day_of_week="sun", hour=3, minute=0),
        id="snapshot_cleanup",
        name="Cleanup old snapshots",
        misfire_grace_time=3600,
    )

    _scheduler.start()
    print("Snapshot scheduler started")

    # 启动时立即执行一次快照收集
    asyncio.create_task(collect_all_snapshots())


def stop_scheduler():
    """停止定时任务调度器"""
    global _scheduler

    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None
        print("Snapshot scheduler stopped")

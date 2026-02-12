"""
资产快照功能测试
"""
import asyncio
import os
import sys
import time
from datetime import datetime, timezone

# 添加项目根目录到 path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


async def test_database():
    """测试数据库模块"""
    print("\n" + "=" * 50)
    print("测试数据库模块")
    print("=" * 50)

    from db import (
        get_db,
        close_db,
        save_snapshot,
        get_snapshots,
        cleanup_old_snapshots,
        get_snapshot_count,
        BalanceSnapshot,
        CurrencySnapshot,
    )

    # 1. 初始化数据库
    print("\n[1] 初始化数据库...")
    db = await get_db()
    assert db is not None, "数据库连接失败"
    print("    ✓ 数据库连接成功")

    # 2. 插入测试快照
    print("\n[2] 插入测试快照...")
    test_account_id = "test_account_001"
    now_ms = int(time.time() * 1000)
    aligned_ts = (now_ms // 60000) * 60000  # 对齐到分钟

    snapshot = BalanceSnapshot(
        account_id=test_account_id,
        timestamp=aligned_ts,
        total_equity=10000.50,
        available=8000.00,
        frozen=500.00,
        margin_used=1500.00,
        unrealized_pnl=200.50,
        currencies=[
            CurrencySnapshot(
                ccy="USDT",
                bal=10000.50,
                avail_bal=8000.00,
                frozen_bal=500.00,
                eq=10000.50,
                eq_usd=10000.50,
            ),
            CurrencySnapshot(
                ccy="BTC",
                bal=0.5,
                avail_bal=0.5,
                frozen_bal=0,
                eq=0.5,
                eq_usd=25000.00,
            ),
        ],
    )

    snapshot_id = await save_snapshot(snapshot)
    assert snapshot_id is not None, "保存快照失败"
    print(f"    ✓ 快照保存成功, ID: {snapshot_id}")

    # 3. 查询快照
    print("\n[3] 查询快照...")
    start_time = aligned_ts - 86400000  # 1天前
    end_time = aligned_ts + 60000  # 1分钟后

    snapshots = await get_snapshots(test_account_id, start_time, end_time)
    assert len(snapshots) > 0, "查询快照失败"
    assert snapshots[0]["total_equity"] == 10000.50, "快照数据不匹配"
    print(f"    ✓ 查询到 {len(snapshots)} 条快照")
    print(f"    ✓ 总权益: {snapshots[0]['total_equity']}")

    # 4. 测试唯一约束 (相同 account_id + timestamp 应该更新)
    print("\n[4] 测试唯一约束 (更新现有记录)...")
    snapshot2 = BalanceSnapshot(
        account_id=test_account_id,
        timestamp=aligned_ts,
        total_equity=10500.00,  # 修改值
        available=8500.00,
        frozen=500.00,
        margin_used=1500.00,
        unrealized_pnl=250.00,
        currencies=[
            CurrencySnapshot(
                ccy="USDT",
                bal=10500.00,
                avail_bal=8500.00,
                frozen_bal=500.00,
                eq=10500.00,
                eq_usd=10500.00,
            ),
        ],
    )
    await save_snapshot(snapshot2)

    snapshots = await get_snapshots(test_account_id, start_time, end_time)
    assert len(snapshots) == 1, "应该只有一条记录 (唯一约束)"
    assert snapshots[0]["total_equity"] == 10500.00, "更新失败"
    print(f"    ✓ 唯一约束生效，记录已更新: {snapshots[0]['total_equity']}")

    # 5. 测试快照计数
    print("\n[5] 测试快照计数...")
    count = await get_snapshot_count(test_account_id)
    assert count == 1, f"计数错误，预期 1，实际 {count}"
    print(f"    ✓ 测试账户快照数: {count}")

    # 6. 清理测试数据
    print("\n[6] 清理测试数据...")
    await db.execute(
        "DELETE FROM balance_snapshots WHERE account_id = ?",
        (test_account_id,),
    )
    await db.commit()

    count = await get_snapshot_count(test_account_id)
    assert count == 0, "清理失败"
    print("    ✓ 测试数据已清理")

    # 7. 关闭数据库
    await close_db()
    print("\n    ✓ 数据库测试通过")


async def test_api_endpoint():
    """测试 API 端点"""
    print("\n" + "=" * 50)
    print("测试 API 端点")
    print("=" * 50)

    from config import ACCOUNTS
    from fastapi.testclient import TestClient
    from main import app
    from db import get_db, save_snapshot, close_db, BalanceSnapshot, CurrencySnapshot

    # 1. 检查是否有可用账户
    if not ACCOUNTS:
        print("\n[!] 没有配置账户，跳过 API 端点测试")
        print("    如需测试 API，请在 .env 中配置 OKX_ACCOUNT")
        return

    test_account_id = ACCOUNTS[0].id
    print(f"\n[1] 使用账户: {ACCOUNTS[0].name} (ID: {test_account_id})")

    # 2. 初始化并插入测试数据
    await get_db()

    now_ms = int(time.time() * 1000)

    # 插入多条快照
    for i in range(5):
        ts = now_ms - (i * 60000)  # 每分钟一条
        aligned_ts = (ts // 60000) * 60000
        snapshot = BalanceSnapshot(
            account_id=test_account_id,
            timestamp=aligned_ts,
            total_equity=10000.00 + i * 100,
            available=8000.00,
            frozen=500.00,
            margin_used=1500.00,
            unrealized_pnl=100.00,
            currencies=[
                CurrencySnapshot(
                    ccy="USDT",
                    bal=10000.00 + i * 100,
                    avail_bal=8000.00,
                    frozen_bal=500.00,
                    eq=10000.00 + i * 100,
                    eq_usd=10000.00 + i * 100,
                ),
            ],
        )
        await save_snapshot(snapshot)

    print(f"    ✓ 插入了 5 条测试快照")

    # 3. 测试 API 响应 (使用同步 TestClient)
    print("\n[2] 测试 equity-curve-v2 API...")

    client = TestClient(app)

    response = client.get(f"/api/accounts/{test_account_id}/equity-curve-v2?days=1")

    assert response.status_code == 200, f"API 返回错误: {response.status_code}"
    data = response.json()

    print(f"    ✓ API 返回状态码: {response.status_code}")
    print(f"    ✓ 数据来源: {data.get('source')}")
    print(f"    ✓ 数据点数: {data.get('total_points')}")

    if data.get('points'):
        print(f"    ✓ 起始余额: {data.get('start_balance')}")
        print(f"    ✓ 结束余额: {data.get('end_balance')}")

    # 4. 测试不同聚合间隔
    print("\n[3] 测试不同聚合间隔...")

    for interval in ["raw", "hourly", "daily"]:
        response = client.get(
            f"/api/accounts/{test_account_id}/equity-curve-v2?days=1&interval={interval}"
        )
        data = response.json()
        print(f"    ✓ interval={interval}: {data.get('total_points')} 点")

    # 5. 清理
    print("\n[4] 清理测试数据...")
    db = await get_db()
    await db.execute(
        "DELETE FROM balance_snapshots WHERE account_id = ?",
        (test_account_id,),
    )
    await db.commit()
    await close_db()
    print("    ✓ 测试数据已清理")


async def test_scheduler_functions():
    """测试调度器函数"""
    print("\n" + "=" * 50)
    print("测试调度器模块")
    print("=" * 50)

    from scheduler.snapshot_task import _align_to_minute, _collect_snapshot
    from db import get_db, close_db, get_snapshots

    # 1. 测试时间对齐
    print("\n[1] 测试时间对齐...")
    now_ms = 1704067200000  # 2024-01-01 00:00:00 UTC
    aligned = _align_to_minute(now_ms)
    assert aligned % 60000 == 0, "时间未对齐到分钟"
    print(f"    ✓ 时间对齐: {now_ms} -> {aligned}")

    # 2. 测试快照收集 (需要有效的账户配置)
    print("\n[2] 测试调度器函数导入...")
    from scheduler import start_scheduler, stop_scheduler
    print("    ✓ start_scheduler 导入成功")
    print("    ✓ stop_scheduler 导入成功")

    # 注意：实际收集需要有效的 OKX API 配置
    print("\n    ⚠ 实际快照收集需要有效的 OKX API 配置")

    await close_db()


async def main():
    """运行所有测试"""
    print("\n" + "=" * 60)
    print(" 资产快照功能测试")
    print("=" * 60)

    try:
        # 测试数据库模块
        await test_database()

        # 测试调度器模块
        await test_scheduler_functions()

        # 测试 API 端点
        await test_api_endpoint()

        print("\n" + "=" * 60)
        print(" ✅ 所有测试通过!")
        print("=" * 60)

    except AssertionError as e:
        print(f"\n❌ 测试失败: {e}")
        raise
    except Exception as e:
        print(f"\n❌ 测试出错: {e}")
        raise
    finally:
        # 确保数据库关闭
        from db import close_db
        await close_db()


if __name__ == "__main__":
    asyncio.run(main())

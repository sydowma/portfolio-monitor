"""
SQLite 数据库连接管理
"""
import os
import aiosqlite
from pathlib import Path

# 数据库文件路径
DATA_DIR = Path(__file__).parent.parent / "data"
DB_PATH = DATA_DIR / "snapshots.db"

# 全局数据库连接
_db_connection: aiosqlite.Connection | None = None


async def get_db() -> aiosqlite.Connection:
    """获取数据库连接"""
    global _db_connection
    if _db_connection is None:
        # 确保数据目录存在
        DATA_DIR.mkdir(parents=True, exist_ok=True)

        _db_connection = await aiosqlite.connect(DB_PATH)
        # 启用外键约束
        await _db_connection.execute("PRAGMA foreign_keys = ON")
        # 返回字典形式的行
        _db_connection.row_factory = aiosqlite.Row

        # 创建表
        await _create_tables(_db_connection)
        print("Database connected")

    return _db_connection


async def close_db():
    """关闭数据库连接"""
    global _db_connection
    if _db_connection:
        await _db_connection.close()
        _db_connection = None
        print("Database disconnected")


async def _create_tables(db: aiosqlite.Connection):
    """创建数据库表"""
    # 主表：资产快照
    await db.execute("""
        CREATE TABLE IF NOT EXISTS balance_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            total_equity REAL NOT NULL,
            available REAL NOT NULL DEFAULT 0,
            frozen REAL NOT NULL DEFAULT 0,
            margin_used REAL NOT NULL DEFAULT 0,
            unrealized_pnl REAL NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            UNIQUE(account_id, timestamp)
        )
    """)

    # 从表：币种详情
    await db.execute("""
        CREATE TABLE IF NOT EXISTS currency_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            snapshot_id INTEGER NOT NULL,
            ccy TEXT NOT NULL,
            bal REAL NOT NULL DEFAULT 0,
            avail_bal REAL NOT NULL DEFAULT 0,
            frozen_bal REAL NOT NULL DEFAULT 0,
            eq REAL NOT NULL DEFAULT 0,
            eq_usd REAL NOT NULL DEFAULT 0,
            FOREIGN KEY (snapshot_id) REFERENCES balance_snapshots(id) ON DELETE CASCADE
        )
    """)

    # 创建索引
    await db.execute("""
        CREATE INDEX IF NOT EXISTS idx_balance_snapshots_account_timestamp
        ON balance_snapshots(account_id, timestamp)
    """)
    await db.execute("""
        CREATE INDEX IF NOT EXISTS idx_currency_snapshots_snapshot
        ON currency_snapshots(snapshot_id)
    """)

    await db.commit()

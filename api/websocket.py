"""
WebSocket 管理器
负责向前端广播实时数据更新
"""
import json
import asyncio
from datetime import datetime, timezone
from typing import Optional
from fastapi import WebSocket

from config import ACCOUNTS, AccountConfig
from models import Balance, Position
from okx import OKXWebSocketClient


class WebSocketManager:
    """
    WebSocket 连接管理器
    - 管理前端 WebSocket 连接
    - 管理 OKX WebSocket 连接
    - 广播数据更新到前端
    """

    def __init__(self):
        # 前端连接
        self._clients: list[WebSocket] = []
        # OKX WebSocket 客户端
        self._okx_clients: dict[str, OKXWebSocketClient] = {}
        # 缓存最新数据
        self._balances: dict[str, dict] = {}
        self._positions: dict[str, list] = {}
        self._pending_orders: dict[str, dict] = {}  # account_id -> {order_id -> order}

    async def connect(self, websocket: WebSocket):
        """接受前端 WebSocket 连接"""
        await websocket.accept()
        self._clients.append(websocket)

        # 发送当前缓存的数据
        await self._send_cached_data(websocket)

    def disconnect(self, websocket: WebSocket):
        """移除前端连接"""
        if websocket in self._clients:
            self._clients.remove(websocket)

    async def _send_cached_data(self, websocket: WebSocket):
        """向新连接发送缓存的数据"""
        for account_id, balance_data in self._balances.items():
            await websocket.send_json({
                "type": "balance",
                "account_id": account_id,
                "data": balance_data,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })

        for account_id, positions_data in self._positions.items():
            await websocket.send_json({
                "type": "positions",
                "account_id": account_id,
                "data": positions_data,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })

        for account_id, orders_dict in self._pending_orders.items():
            await websocket.send_json({
                "type": "pending_orders",
                "account_id": account_id,
                "data": list(orders_dict.values()),
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })

    async def broadcast(self, message: dict):
        """广播消息到所有前端连接"""
        dead_clients = []

        for client in self._clients:
            try:
                await client.send_json(message)
            except Exception:
                dead_clients.append(client)

        # 清理断开的连接
        for client in dead_clients:
            self.disconnect(client)

    async def _on_balance_update(self, account_id: str, data: list):
        """处理 OKX 账户数据更新"""
        if not data:
            return

        # 辅助函数：安全解析浮点数（处理空字符串）
        def safe_float(val, default=0):
            if val is None or val == "":
                return default
            try:
                return float(val)
            except (ValueError, TypeError):
                return default

        account_data = data[0]
        details = account_data.get("details", [])
        
        # 查找 USDT 余额详情
        usdt_detail = next((d for d in details if d.get("ccy") == "USDT"), None)
        available = safe_float(usdt_detail.get("availBal")) if usdt_detail else 0
        frozen = safe_float(usdt_detail.get("frozenBal")) if usdt_detail else 0

        # 解析各币种资产
        assets = []
        for detail in details:
            bal = safe_float(detail.get("cashBal"))
            eq = safe_float(detail.get("eq"))
            # 只保留有余额或有权益的币种
            if bal > 0 or eq > 0:
                assets.append({
                    "ccy": detail.get("ccy", ""),
                    "bal": bal,
                    "avail_bal": safe_float(detail.get("availBal")),
                    "frozen_bal": safe_float(detail.get("frozenBal")),
                    "eq": eq,
                    "eq_usd": safe_float(detail.get("eqUsd")),
                })
        
        # 按权益排序
        assets.sort(key=lambda x: x["eq"], reverse=True)

        balance_info = {
            "total_equity": safe_float(account_data.get("totalEq")),
            "available": available,
            "frozen": frozen,
            "unrealized_pnl": safe_float(account_data.get("upl")),
            "margin_used": safe_float(account_data.get("imr")),
            "assets": assets,
        }

        # 缓存并广播
        self._balances[account_id] = balance_info
        await self.broadcast({
            "type": "balance",
            "account_id": account_id,
            "data": balance_info,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })

    async def _on_positions_update(self, account_id: str, data: list):
        """处理 OKX 仓位数据更新"""
        positions = []
        for item in data:
            pos = float(item.get("pos", 0))
            if pos == 0:
                continue

            positions.append({
                "inst_id": item.get("instId", ""),
                "pos_side": item.get("posSide", "net"),
                "pos": pos,
                "avg_px": float(item.get("avgPx", 0) or 0),
                "mark_px": float(item.get("markPx", 0) or 0),
                "upl": float(item.get("upl", 0) or 0),
                "upl_ratio": float(item.get("uplRatio", 0) or 0),
                "margin": float(item.get("margin", 0) or 0),
                "lever": int(item.get("lever", 1) or 1),
            })

        # 缓存并广播
        self._positions[account_id] = positions
        await self.broadcast({
            "type": "positions",
            "account_id": account_id,
            "data": positions,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })

    async def _on_orders_update(self, account_id: str, data: list):
        """处理 OKX 订单状态更新"""
        if account_id not in self._pending_orders:
            self._pending_orders[account_id] = {}

        for item in data:
            order_id = item.get("ordId", "")
            state = item.get("state", "")

            # 只保留在途订单 (live/partially_filled)
            if state in ("live", "partially_filled"):
                # 转换时间戳为 ISO 格式，与 REST API 保持一致
                created_at = None
                updated_at = None
                if item.get("cTime"):
                    created_at = datetime.fromtimestamp(
                        int(item.get("cTime")) / 1000, tz=timezone.utc
                    ).isoformat()
                if item.get("uTime"):
                    updated_at = datetime.fromtimestamp(
                        int(item.get("uTime")) / 1000, tz=timezone.utc
                    ).isoformat()

                self._pending_orders[account_id][order_id] = {
                    "order_id": order_id,
                    "inst_id": item.get("instId", ""),
                    "side": item.get("side", ""),
                    "pos_side": item.get("posSide", "net"),
                    "order_type": item.get("ordType", ""),
                    "sz": float(item.get("sz", 0)),
                    "px": float(item.get("px", 0)) if item.get("px") else None,
                    "fill_sz": float(item.get("fillSz", 0) or 0),
                    "avg_px": float(item.get("avgPx", 0)) if item.get("avgPx") else None,
                    "state": state,
                    "lever": int(item.get("lever", 1) or 1),
                    "created_at": created_at,
                    "updated_at": updated_at,
                }
            else:
                # 订单已完成（filled/canceled等），从缓存移除
                self._pending_orders[account_id].pop(order_id, None)

        # 广播更新后的在途订单列表
        await self.broadcast({
            "type": "pending_orders",
            "account_id": account_id,
            "data": list(self._pending_orders[account_id].values()),
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })

    async def _on_error(self, account_id: str, error: str):
        """处理 OKX 连接错误"""
        await self.broadcast({
            "type": "error",
            "account_id": account_id,
            "message": error,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })

    async def start_okx_connections(self):
        """启动所有 OKX WebSocket 连接"""
        tasks = []

        for account in ACCOUNTS:
            client = OKXWebSocketClient(
                account,
                on_balance=self._on_balance_update,
                on_positions=self._on_positions_update,
                on_orders=self._on_orders_update,
                on_error=self._on_error,
            )
            self._okx_clients[account.id] = client
            tasks.append(asyncio.create_task(client.connect()))

        print(f"Started OKX WebSocket connections for {len(ACCOUNTS)} accounts")

        # 不等待，让连接在后台运行
        # await asyncio.gather(*tasks)

    async def stop_okx_connections(self):
        """停止所有 OKX WebSocket 连接"""
        for client in self._okx_clients.values():
            await client.disconnect()
        self._okx_clients.clear()


# 全局单例
ws_manager = WebSocketManager()


"""
OKX WebSocket 客户端
用于实时订阅账户和仓位变化
"""
import os
import json
import hmac
import base64
import hashlib
import asyncio
from datetime import datetime, timezone
from typing import Callable, Optional
import websockets
from websockets.exceptions import ConnectionClosed

from config import AccountConfig


def get_proxy_url() -> Optional[str]:
    """
    从环境变量获取代理 URL
    优先使用 SOCKS5 代理（对 WebSocket 更友好）
    """
    # 优先 SOCKS5 代理
    all_proxy = os.getenv("all_proxy") or os.getenv("ALL_PROXY")
    if all_proxy:
        return all_proxy

    # 备选 HTTPS 代理
    https_proxy = os.getenv("https_proxy") or os.getenv("HTTPS_PROXY")
    if https_proxy:
        return https_proxy

    return None


class OKXWebSocketClient:
    """OKX WebSocket 客户端"""

    def __init__(
        self,
        account: AccountConfig,
        on_balance: Optional[Callable] = None,
        on_positions: Optional[Callable] = None,
        on_orders: Optional[Callable] = None,
        on_error: Optional[Callable] = None,
    ):
        self.account = account
        self.on_balance = on_balance
        self.on_positions = on_positions
        self.on_orders = on_orders
        self.on_error = on_error

        self._ws: Optional[websockets.WebSocketClientProtocol] = None
        self._running = False
        self._reconnect_delay = 5

    def _sign(self, timestamp: str) -> str:
        """生成登录签名"""
        message = timestamp + "GET" + "/users/self/verify"
        mac = hmac.new(
            self.account.secret_key.encode("utf-8"),
            message.encode("utf-8"),
            hashlib.sha256,
        )
        return base64.b64encode(mac.digest()).decode("utf-8")

    async def _login(self):
        """登录认证"""
        timestamp = str(int(datetime.now(timezone.utc).timestamp()))
        sign = self._sign(timestamp)

        login_msg = {
            "op": "login",
            "args": [
                {
                    "apiKey": self.account.api_key,
                    "passphrase": self.account.passphrase,
                    "timestamp": timestamp,
                    "sign": sign,
                }
            ],
        }

        await self._ws.send(json.dumps(login_msg))

        # 等待登录响应
        resp = await self._ws.recv()
        data = json.loads(resp)

        if data.get("event") == "error" or data.get("code") != "0":
            raise Exception(f"Login failed: {data.get('msg', 'Unknown error')}")

        print(f"[{self.account.name}] WebSocket logged in")

    async def _subscribe(self):
        """订阅账户、仓位和订单频道"""
        sub_msg = {
            "op": "subscribe",
            "args": [
                {"channel": "account"},
                {"channel": "positions", "instType": "SWAP"},
                {"channel": "orders", "instType": "SWAP"},
            ],
        }
        await self._ws.send(json.dumps(sub_msg))
        print(f"[{self.account.name}] Subscribed to account, positions and orders")

    async def _handle_message(self, message: str):
        """处理收到的消息"""
        try:
            data = json.loads(message)

            # 忽略订阅确认等事件消息
            if "event" in data:
                return

            arg = data.get("arg", {})
            channel = arg.get("channel")

            if channel == "account" and self.on_balance:
                # 账户数据更新
                await self.on_balance(self.account.id, data.get("data", []))

            elif channel == "positions" and self.on_positions:
                # 仓位数据更新
                await self.on_positions(self.account.id, data.get("data", []))

            elif channel == "orders" and self.on_orders:
                # 订单状态更新
                await self.on_orders(self.account.id, data.get("data", []))

        except json.JSONDecodeError:
            print(f"[{self.account.name}] Invalid JSON: {message[:100]}")
        except Exception as e:
            print(f"[{self.account.name}] Handle message error: {e}")
            if self.on_error:
                await self.on_error(self.account.id, str(e))

    async def _ping_loop(self):
        """心跳保活"""
        while self._running and self._ws:
            try:
                await asyncio.sleep(25)  # OKX 要求 30 秒内发送心跳
                if self._ws:
                    await self._ws.send("ping")
            except Exception:
                break

    async def connect(self):
        """建立连接并开始监听"""
        self._running = True
        proxy = get_proxy_url()

        while self._running:
            try:
                async with websockets.connect(self.account.ws_url, proxy=proxy) as ws:
                    self._ws = ws
                    proxy_info = f" (via {proxy})" if proxy else ""
                    print(f"[{self.account.name}] WebSocket connected{proxy_info}")

                    await self._login()
                    await self._subscribe()

                    # 启动心跳
                    ping_task = asyncio.create_task(self._ping_loop())

                    try:
                        async for message in ws:
                            if message == "pong":
                                continue
                            await self._handle_message(message)
                    finally:
                        ping_task.cancel()

            except ConnectionClosed as e:
                print(f"[{self.account.name}] Connection closed: {e}")
            except Exception as e:
                print(f"[{self.account.name}] WebSocket error: {e}")
                if self.on_error:
                    await self.on_error(self.account.id, str(e))

            if self._running:
                print(f"[{self.account.name}] Reconnecting in {self._reconnect_delay}s...")
                await asyncio.sleep(self._reconnect_delay)

    async def disconnect(self):
        """断开连接"""
        self._running = False
        if self._ws:
            await self._ws.close()
            self._ws = None


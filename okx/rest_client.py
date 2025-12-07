"""
OKX REST API 客户端
用于获取账户资产、仓位、历史订单等
"""
import hmac
import base64
import hashlib
from datetime import datetime, timezone
from typing import Optional
import httpx

from config import AccountConfig
from models import Balance, Position, Order, Bill, CurrencyAsset, PendingOrder


class OKXRestClient:
    """OKX REST API 客户端"""

    BASE_URL = "https://www.okx.com"

    def __init__(self, account: AccountConfig):
        self.account = account
        self.client = httpx.AsyncClient(timeout=30.0)

    def _sign(self, timestamp: str, method: str, path: str, body: str = "") -> str:
        """生成签名"""
        message = timestamp + method + path + body
        mac = hmac.new(
            self.account.secret_key.encode("utf-8"),
            message.encode("utf-8"),
            hashlib.sha256,
        )
        return base64.b64encode(mac.digest()).decode("utf-8")

    def _get_headers(self, method: str, path: str, body: str = "") -> dict:
        """构建请求头"""
        timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
        sign = self._sign(timestamp, method, path, body)

        headers = {
            "OK-ACCESS-KEY": self.account.api_key,
            "OK-ACCESS-SIGN": sign,
            "OK-ACCESS-TIMESTAMP": timestamp,
            "OK-ACCESS-PASSPHRASE": self.account.passphrase,
            "Content-Type": "application/json",
        }

        # 模拟盘标识
        if self.account.simulated:
            headers["x-simulated-trading"] = "1"

        return headers

    async def _request(self, method: str, path: str, params: dict = None) -> dict:
        """发送请求"""
        url = self.BASE_URL + path
        body = ""

        if params:
            if method == "GET":
                query = "&".join(f"{k}={v}" for k, v in params.items() if v is not None)
                if query:
                    path = f"{path}?{query}"
                    url = f"{url}?{query}"
            else:
                import json
                body = json.dumps(params)

        headers = self._get_headers(method, path, body)

        if method == "GET":
            resp = await self.client.get(url, headers=headers)
        else:
            resp = await self.client.post(url, headers=headers, content=body)

        data = resp.json()

        if data.get("code") != "0":
            raise Exception(f"OKX API Error: {data.get('msg', 'Unknown error')}")

        return data.get("data", [])

    async def get_balance(self) -> Balance:
        """获取账户资产 (统一账户)"""
        data = await self._request("GET", "/api/v5/account/balance")

        if not data:
            return Balance(
                total_equity=0,
                available=0,
                frozen=0,
                margin_used=0,
                unrealized_pnl=0,
                assets=[],
            )

        account_data = data[0]
        details = account_data.get("details", [])

        # 计算 USDT 为主的资产
        total_equity = float(account_data.get("totalEq", 0))
        
        # 查找 USDT 余额详情
        usdt_detail = next((d for d in details if d.get("ccy") == "USDT"), None)
        available = float(usdt_detail.get("availBal", 0)) if usdt_detail else 0
        frozen = float(usdt_detail.get("frozenBal", 0)) if usdt_detail else 0

        # 已用保证金和未实现盈亏
        margin_used = float(account_data.get("imr", 0))  # 初始保证金
        unrealized_pnl = float(account_data.get("upl", 0))

        # 解析各币种资产
        assets = []
        for detail in details:
            bal = float(detail.get("cashBal", 0) or 0)
            eq = float(detail.get("eq", 0) or 0)
            # 只保留有余额或有权益的币种
            if bal > 0 or eq > 0:
                assets.append(CurrencyAsset(
                    ccy=detail.get("ccy", ""),
                    bal=bal,
                    avail_bal=float(detail.get("availBal", 0) or 0),
                    frozen_bal=float(detail.get("frozenBal", 0) or 0),
                    eq=eq,
                    eq_usd=float(detail.get("eqUsd", 0) or 0),
                ))
        
        # 按权益排序，大的在前
        assets.sort(key=lambda x: x.eq, reverse=True)

        return Balance(
            total_equity=total_equity,
            available=available,
            frozen=frozen,
            margin_used=margin_used,
            unrealized_pnl=unrealized_pnl,
            assets=assets,
        )

    async def get_positions(self) -> list[Position]:
        """获取合约仓位"""
        data = await self._request("GET", "/api/v5/account/positions", {"instType": "SWAP"})

        positions = []
        for item in data:
            # 跳过空仓位
            pos = float(item.get("pos", 0))
            if pos == 0:
                continue

            positions.append(Position(
                inst_id=item.get("instId", ""),
                pos_side=item.get("posSide", "net"),
                pos=pos,
                avg_px=float(item.get("avgPx", 0) or 0),
                mark_px=float(item.get("markPx", 0) or 0),
                upl=float(item.get("upl", 0) or 0),
                upl_ratio=float(item.get("uplRatio", 0) or 0),
                margin=float(item.get("margin", 0) or 0),
                lever=int(item.get("lever", 1) or 1),
                liq_px=float(item.get("liqPx", 0) or 0) if item.get("liqPx") else None,
                created_at=datetime.fromtimestamp(
                    int(item.get("cTime", 0)) / 1000, tz=timezone.utc
                ) if item.get("cTime") else None,
            ))

        return positions

    async def get_orders_history(
        self,
        start_time: Optional[datetime] = None,
        end_time: Optional[datetime] = None,
        after: Optional[str] = None,
        limit: int = 50,
    ) -> tuple[list[Order], bool, Optional[str]]:
        """
        获取历史订单（分页）
        返回: (订单列表, 是否有更多, 最后一条ID)
        """
        params = {
            "instType": "SWAP",
            "limit": str(min(limit, 100)),
        }

        if start_time:
            params["begin"] = str(int(start_time.timestamp() * 1000))
        if end_time:
            params["end"] = str(int(end_time.timestamp() * 1000))
        if after:
            params["after"] = after

        # 先查近 7 天的订单
        data = await self._request("GET", "/api/v5/trade/orders-history", params)

        # 如果结果不够且需要更早的订单，查归档接口
        if len(data) < limit and not after:
            archive_params = params.copy()
            archive_data = await self._request(
                "GET", "/api/v5/trade/orders-history-archive", archive_params
            )
            data.extend(archive_data)

        orders = []
        for item in data:
            orders.append(Order(
                order_id=item.get("ordId", ""),
                inst_id=item.get("instId", ""),
                side=item.get("side", ""),
                pos_side=item.get("posSide", ""),
                order_type=item.get("ordType", ""),
                sz=float(item.get("sz", 0)),
                px=float(item.get("px", 0)) if item.get("px") else None,
                avg_px=float(item.get("avgPx", 0)) if item.get("avgPx") else None,
                state=item.get("state", ""),
                pnl=float(item.get("pnl", 0) or 0),
                fee=float(item.get("fee", 0) or 0),
                created_at=datetime.fromtimestamp(
                    int(item.get("cTime", 0)) / 1000, tz=timezone.utc
                ),
                updated_at=datetime.fromtimestamp(
                    int(item.get("uTime", 0)) / 1000, tz=timezone.utc
                ),
            ))

        has_more = len(data) >= limit
        last_id = orders[-1].order_id if orders else None

        return orders, has_more, last_id

    async def get_pending_orders(self, inst_type: str = "SWAP") -> list[PendingOrder]:
        """获取当前挂单（未成交/部分成交）"""
        data = await self._request("GET", "/api/v5/trade/orders-pending", {"instType": inst_type})

        orders = []
        for item in data:
            orders.append(PendingOrder(
                order_id=item.get("ordId", ""),
                inst_id=item.get("instId", ""),
                side=item.get("side", ""),
                pos_side=item.get("posSide", "net"),
                order_type=item.get("ordType", ""),
                sz=float(item.get("sz", 0)),
                px=float(item.get("px", 0)) if item.get("px") else None,
                fill_sz=float(item.get("fillSz", 0) or 0),
                avg_px=float(item.get("avgPx", 0)) if item.get("avgPx") else None,
                state=item.get("state", ""),
                lever=int(item.get("lever", 1) or 1),
                created_at=datetime.fromtimestamp(
                    int(item.get("cTime", 0)) / 1000, tz=timezone.utc
                ),
                updated_at=datetime.fromtimestamp(
                    int(item.get("uTime", 0)) / 1000, tz=timezone.utc
                ),
            ))

        return orders

    async def get_bills(
        self,
        bill_type: Optional[str] = None,
        inst_id: Optional[str] = None,
        start_time: Optional[datetime] = None,
        end_time: Optional[datetime] = None,
        after: Optional[str] = None,
        limit: int = 50,
    ) -> tuple[list[Bill], bool, Optional[str]]:
        """
        获取账单流水（分页）
        返回: (账单列表, 是否有更多, 最后一条ID)
        """
        params = {
            "instType": "SWAP",
            "limit": str(min(limit, 100)),
        }

        if bill_type:
            params["type"] = bill_type
        if inst_id:
            params["instId"] = inst_id
        if start_time:
            params["begin"] = str(int(start_time.timestamp() * 1000))
        if end_time:
            params["end"] = str(int(end_time.timestamp() * 1000))
        if after:
            params["after"] = after

        # 先查近 7 天
        data = await self._request("GET", "/api/v5/account/bills", params)

        # 如果结果不够且需要更早的账单，查归档接口
        if len(data) < limit and not after:
            archive_params = params.copy()
            archive_data = await self._request(
                "GET", "/api/v5/account/bills-archive", archive_params
            )
            data.extend(archive_data)

        bills = []
        for item in data:
            bills.append(Bill(
                bill_id=item.get("billId", ""),
                inst_id=item.get("instId", ""),
                ccy=item.get("ccy", ""),
                bill_type=item.get("type", ""),
                sub_type=item.get("subType", ""),
                pnl=float(item.get("pnl", 0) or 0),
                fee=float(item.get("fee", 0) or 0),
                bal=float(item.get("bal", 0) or 0),
                bal_chg=float(item.get("balChg", 0) or 0),
                sz=float(item.get("sz", 0) or 0),
                px=float(item.get("px", 0)) if item.get("px") else None,
                exec_type=item.get("execType") or None,
                from_account=item.get("from") or None,
                to_account=item.get("to") or None,
                notes=item.get("notes") or None,
                interest=float(item.get("interest", 0) or 0) if item.get("interest") else None,
                timestamp=datetime.fromtimestamp(
                    int(item.get("ts", 0)) / 1000, tz=timezone.utc
                ),
            ))

        has_more = len(data) >= limit
        last_id = bills[-1].bill_id if bills else None

        return bills, has_more, last_id

    async def close(self):
        """关闭客户端"""
        await self.client.aclose()


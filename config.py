"""
配置加载模块
从环境变量中自动扫描并加载所有 OKX 账户配置
"""
import os
import re
from dataclasses import dataclass
from typing import Optional
from dotenv import load_dotenv

load_dotenv()


@dataclass
class AccountConfig:
    """单个账户配置"""
    id: str
    name: str
    api_key: str
    secret_key: str
    passphrase: str
    simulated: bool = False  # 是否模拟盘

    @property
    def base_url(self) -> str:
        """根据是否模拟盘返回对应的 API 地址"""
        if self.simulated:
            return "https://www.okx.com"  # 模拟盘也用这个，通过 header 区分
        return "https://www.okx.com"

    @property
    def ws_url(self) -> str:
        """WebSocket 地址"""
        if self.simulated:
            return "wss://wspap.okx.com:8443/ws/v5/private?brokerId=9999"
        return "wss://ws.okx.com:8443/ws/v5/private"


def load_accounts() -> list[AccountConfig]:
    """
    从环境变量加载所有账户配置
    扫描所有匹配 OKX_ACCOUNT_{N}_NAME 格式的环境变量（不要求连续编号）
    """
    accounts = []
    pattern = re.compile(r"^OKX_ACCOUNT_(\d+)_NAME$")

    # 找出所有匹配的账户编号
    account_indices = []
    for key in os.environ:
        match = pattern.match(key)
        if match:
            account_indices.append(int(match.group(1)))

    # 按编号排序
    account_indices.sort()

    for index in account_indices:
        prefix = f"OKX_ACCOUNT_{index}_"
        name = os.getenv(f"{prefix}NAME")
        api_key = os.getenv(f"{prefix}API_KEY")
        secret_key = os.getenv(f"{prefix}SECRET_KEY")
        passphrase = os.getenv(f"{prefix}PASSPHRASE")
        simulated = os.getenv(f"{prefix}SIMULATED", "false").lower() == "true"

        # 跳过配置不完整的账户
        if not all([api_key, secret_key, passphrase]):
            print(f"Warning: Account {index} ({name}) has incomplete config, skipping")
            continue

        accounts.append(AccountConfig(
            id=str(index),
            name=name,
            api_key=api_key,
            secret_key=secret_key,
            passphrase=passphrase,
            simulated=simulated,
        ))

    return accounts


# 全局账户列表
ACCOUNTS = load_accounts()

# 账户 ID 到配置的映射
ACCOUNTS_MAP: dict[str, AccountConfig] = {acc.id: acc for acc in ACCOUNTS}


def get_account(account_id: str) -> Optional[AccountConfig]:
    """根据 ID 获取账户配置"""
    return ACCOUNTS_MAP.get(account_id)


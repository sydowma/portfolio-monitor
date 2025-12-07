"""
资产曲线 Demo - 验证方案 B 可行性
基于账单流水的 bal 字段反推历史资产
"""
import asyncio
from datetime import datetime, timedelta, timezone
from collections import defaultdict

from config import ACCOUNTS
from okx import OKXRestClient


async def fetch_equity_curve(account_id: str = "1", days: int = 30):
    """
    获取指定账户的资产曲线数据
    
    Args:
        account_id: 账户 ID
        days: 查询最近多少天的数据
    """
    # 找到账户
    account = next((acc for acc in ACCOUNTS if acc.id == account_id), None)
    if not account:
        print(f"账户 {account_id} 不存在")
        print(f"可用账户: {[acc.id + ':' + acc.name for acc in ACCOUNTS]}")
        return

    print(f"\n=== 账户: {account.name} (ID: {account.id}) ===")
    print(f"查询范围: 最近 {days} 天")
    print("-" * 50)

    client = OKXRestClient(account)
    
    try:
        # 时间范围
        end_time = datetime.now(timezone.utc)
        start_time = end_time - timedelta(days=days)
        
        # 收集所有账单
        all_bills = []
        after = None
        page = 1
        
        while True:
            print(f"正在获取第 {page} 页账单...")
            bills, has_more, last_id = await client.get_bills(
                bill_type=None,  # 所有类型
                inst_id=None,
                start_time=start_time,
                end_time=end_time,
                after=after,
                limit=100,
            )
            
            all_bills.extend(bills)
            print(f"  本页获取 {len(bills)} 条，累计 {len(all_bills)} 条")
            
            if not has_more or not last_id:
                break
            
            after = last_id
            page += 1
            
            # 安全限制
            if page > 50:
                print("  达到页数上限，停止获取")
                break
        
        if not all_bills:
            print("\n没有找到账单记录")
            return
        
        # 按币种分组
        bills_by_ccy = defaultdict(list)
        for bill in all_bills:
            bills_by_ccy[bill.ccy].append(bill)
        
        print(f"\n=== 账单统计 ===")
        print(f"总账单数: {len(all_bills)}")
        print(f"涉及币种: {list(bills_by_ccy.keys())}")
        
        # 主要关注 USDT（合约账户的主要结算币种）
        usdt_bills = bills_by_ccy.get("USDT", [])
        
        if not usdt_bills:
            print("\n没有 USDT 账单记录，尝试查看其他币种...")
            # 显示最大数量的币种
            max_ccy = max(bills_by_ccy.keys(), key=lambda k: len(bills_by_ccy[k]))
            usdt_bills = bills_by_ccy[max_ccy]
            print(f"使用 {max_ccy} 币种数据 ({len(usdt_bills)} 条)")
        else:
            print(f"\nUSDT 账单数: {len(usdt_bills)}")
        
        # 按时间排序（从早到晚）
        usdt_bills.sort(key=lambda b: b.timestamp)
        
        # 构建资产曲线数据点
        print(f"\n=== 资产曲线数据点 (USDT) ===")
        print(f"{'时间':<25} {'余额':>15} {'变动':>12} {'类型':<10} {'合约':<20}")
        print("-" * 90)
        
        curve_points = []
        for bill in usdt_bills:
            curve_points.append({
                "timestamp": bill.timestamp.isoformat(),
                "balance": bill.bal,
                "change": bill.bal_chg,
                "type": bill.bill_type,
                "sub_type": bill.sub_type,
                "inst_id": bill.inst_id,
            })
            
            # 打印前 30 条和后 10 条
            idx = usdt_bills.index(bill)
            if idx < 30 or idx >= len(usdt_bills) - 10:
                time_str = bill.timestamp.strftime("%Y-%m-%d %H:%M:%S")
                change_str = f"{bill.bal_chg:+.4f}" if bill.bal_chg else "0"
                print(f"{time_str:<25} {bill.bal:>15.4f} {change_str:>12} {bill.bill_type:<10} {bill.inst_id:<20}")
            elif idx == 30:
                print(f"... 省略 {len(usdt_bills) - 40} 条 ...")
        
        # 汇总统计
        print(f"\n=== 汇总 ===")
        if curve_points:
            first = curve_points[0]
            last = curve_points[-1]
            print(f"起始余额: {first['balance']:.4f} USDT ({first['timestamp'][:10]})")
            print(f"最新余额: {last['balance']:.4f} USDT ({last['timestamp'][:10]})")
            print(f"数据点数: {len(curve_points)}")
            
            # 计算每天的数据点分布
            days_with_data = set()
            for p in curve_points:
                days_with_data.add(p['timestamp'][:10])
            print(f"有数据的天数: {len(days_with_data)} / {days} 天")
        
        # 账单类型分布
        type_counts = defaultdict(int)
        for bill in usdt_bills:
            type_counts[bill.bill_type] += 1
        
        print(f"\n=== 账单类型分布 ===")
        for t, c in sorted(type_counts.items(), key=lambda x: -x[1]):
            type_name = {
                "1": "划转",
                "2": "交易",
                "3": "交割",
                "4": "自动换币",
                "5": "强平",
                "6": "保证金划转",
                "7": "利息扣除",
                "8": "资金费",
                "9": "ADL减仓",
                "10": "理财",
            }.get(t, f"未知({t})")
            print(f"  {type_name}: {c} 条")
            
    except Exception as e:
        print(f"错误: {e}")
        import traceback
        traceback.print_exc()
    finally:
        await client.close()


async def main():
    """主函数"""
    if not ACCOUNTS:
        print("没有配置任何账户，请检查 .env 文件")
        return
    
    print("已配置的账户:")
    for acc in ACCOUNTS:
        sim = " (模拟盘)" if acc.simulated else ""
        print(f"  [{acc.id}] {acc.name}{sim}")
    
    # 默认查询第一个账户，最近 30 天
    await fetch_equity_curve(account_id="1", days=30)


if __name__ == "__main__":
    asyncio.run(main())


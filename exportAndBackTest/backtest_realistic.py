import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import os
import glob
import argparse
from datetime import datetime
from collections import deque

# 导入图表库，支持多种模式
INTERACTIVE_MODE = True  # 设置为True启用matplotlib交互模式

# 暂时禁用plotly，使用matplotlib交互模式
PLOTLY_AVAILABLE = False

print("使用 matplotlib 交互模式（支持拖动、缩放）")

# 配置参数
USE_SAMPLING = False        # True: 随机抽样1小时, False: 全量数据
SAMPLE_HOURS = 1          # 抽取1小时数据（仅当USE_SAMPLING=True时使用）
WINDOW_MIN = 30           # 30分钟滚动窗口（可通过命令行参数覆盖）
Z_OPEN = 1.0             # 开仓阈值（可通过命令行参数覆盖）
Z_CLOSE = 0.0             # 平仓阈值（可通过命令行参数覆盖）

# 成本参数
CEX_FEE_RATE = 0.00036    # CEX 手续费率 0.036%
REBATE_RATE = 0.45        # 反佣比例 45%
DEX_SLIPPAGE_RATE = 0.0002  # DEX 滑点 0.02%

# 币种配置：每个币种的交易size和最大仓位
SYMBOL_CONFIG = {
    'DAM-USDT': {'trade_size': 2000, 'max_position': 32000},
    'BULLA-USDT': {'trade_size': 1500, 'max_position': 24000},
    '币安人生-USDT': {'trade_size': 570, 'max_position': 9120},
    '4-USDT': {'trade_size': 1500, 'max_position': 24000},
    'TAG-USDT': {'trade_size': 100000, 'max_position': 160000},
    'JCT-USDT': {'trade_size': 15000, 'max_position': 240000},
    'BEAT-USDT': {'trade_size': 50, 'max_position': 800},
    'FOLKS-USDT': {'trade_size': 6, 'max_position': 96},
    'TAKE-USDT': {'trade_size': 190, 'max_position': 3040},
    'BLESS-USDT': {'trade_size': 3000, 'max_position': 48000},
    'BDXN-USDT': {'trade_size': 1000, 'max_position': 16000},
    'APR-USDT': {'trade_size': 200, 'max_position': 3200},
    'VELVET-USDT': {'trade_size': 280, 'max_position': 4480},
    'COMMON-USDT': {'trade_size': 6500, 'max_position': 104000},
    'TRADOOR-USDT': {'trade_size': 20, 'max_position': 320},
    'AKE-USDT': {'trade_size': 130000, 'max_position': 2080000},
    'CLO-USDT': {'trade_size': 240, 'max_position': 3840},
    'TAC-USDT': {'trade_size': 12000, 'max_position': 192000},
    'LIGHT-USDT': {'trade_size': 50, 'max_position': 800},
    'PLAY-USDT': {'trade_size': 1700, 'max_position': 27200},
    'ASTER-USDT': {'trade_size': 45, 'max_position': 720},
    '42-USDT': {'trade_size': 1000, 'max_position': 16000},
    'LAB-USDT': {'trade_size': 500, 'max_position': 8000},
    'ESPORTS-USDT': {'trade_size': 120, 'max_position': 1920},
    'PIEVERSE-USDT': {'trade_size': 100, 'max_position': 1600},
    'HANA-USDT': {'trade_size': 3000, 'max_position': 48000},
    'IDOL-USDT': {'trade_size': 16000, 'max_position': 256000},
    'EVAA-USDT': {'trade_size': 45, 'max_position': 720},
    'XAN-USDT': {'trade_size': 1800, 'max_position': 28800},
    'XPIN-USDT': {'trade_size': 23000, 'max_position': 36800}
}

# 路径配置
# DATA_DIR = 'd:/code/z-score-sim/z-score-sim/data/1130/exported-prices'
DATA_DIR = './data/meta_data'
# OUTPUT_DIR = '/tmp/output_realistic'
# OUTPUT_DIR = './output_realistic'
OUTPUT_DIR = './data/output'


def sample_one_hour(df):
    """随机选择1小时的连续数据"""
    df = df.sort_values('timestamp').reset_index(drop=True)
    min_time = df['timestamp'].min()
    max_time = df['timestamp'].max()
    one_hour_ms = 3600000
    valid_start_max = max_time - one_hour_ms

    if valid_start_max <= min_time:
        print("  警告: 数据不足1小时，返回全部数据")
        return df

    random_start = np.random.randint(min_time, valid_start_max)
    random_end = random_start + one_hour_ms
    sample = df[(df['timestamp'] >= random_start) &
                (df['timestamp'] <= random_end)].copy()

    print(f"  抽样时间: {pd.to_datetime(random_start, unit='ms').strftime('%Y-%m-%d %H:%M:%S')} ~ "
          f"{pd.to_datetime(random_end, unit='ms').strftime('%H:%M:%S')}")

    return sample.reset_index(drop=True)


def calculate_spreads_and_zscore(df, window_min=30):
    """
    计算价差和z-score

    spread_ab = (dex_bid * 0.9995 - cex_ask * 1.0002) / (cex_ask * 1.0002) * 100  (卖dex买cex，-a+b)
    spread_ba = (cex_bid * 0.9998 - dex_ask * 1.0005) / (dex_ask * 1.0005) * 100  (买dex卖cex，+a-b)

    两个价差都用spread_ab的均值和标准差计算z-score
    """
    df['datetime'] = pd.to_datetime(df['timestamp'], unit='ms')
    df = df.set_index('datetime').sort_index()

    # 计算价差（如果数据中没有或需要重新计算）
    # spread_ab = (dex_bid * 0.9995 - cex_ask * 1.0002) / (cex_ask * 1.0002) * 100
    # spread_ba = (cex_bid * 0.9998 - dex_ask * 1.0005) / (dex_ask * 1.0005) * 100
    cex_ask_adj = df['cex_ask'] * 1.0002
    dex_ask_adj = df['dex_ask'] * 1.0005
    df['spread_ab_calc'] = (df['dex_bid'] * 0.9995 - cex_ask_adj) / cex_ask_adj * 100
    df['spread_ba_calc'] = (df['cex_bid'] * 0.9998 - dex_ask_adj) / dex_ask_adj * 100

    # 直接使用数据中原有的spread值
    if 'spread_ab' in df.columns and 'spread_ba' in df.columns:
        print("  使用数据中原有的spread_ab和spread_ba")
        # 确保spread值在合理范围内（-2到2）
        df['spread_ab'] = df['spread_ab'].clip(-2, 2)
        df['spread_ba'] = df['spread_ba'].clip(-2, 2)
    else:
        print("  警告：数据中没有spread列，使用计算值")
        df['spread_ab'] = df['spread_ab_calc']
        df['spread_ba'] = df['spread_ba_calc']

    # 计算滚动统计量（计算两个价差各自的统计量）
    window = f'{window_min}min'
    print(f"  计算{window_min}分钟滚动窗口统计量（动态选择）...")

    # 计算 spread_ab 的统计量
    df['mean_ab'] = df['spread_ab'].rolling(window, min_periods=10).mean()
    df['std_ab'] = df['spread_ab'].rolling(window, min_periods=10).std()
    df['std_ab'] = df['std_ab'].replace(0, np.nan).fillna(0.0001)

    # 计算 spread_ba 的统计量
    df['mean_ba'] = df['spread_ba'].rolling(window, min_periods=10).mean()
    df['std_ba'] = df['spread_ba'].rolling(window, min_periods=10).std()
    df['std_ba'] = df['std_ba'].replace(0, np.nan).fillna(0.0001)

    # # 动态选择：比较 |mean_ab| 和 |mean_ba|，使用绝对值更大的统计量
    # # 如果 |mean_ab| > |mean_ba|，使用 mean_ab 和 std_ab
    # # 否则使用 mean_ba 和 std_ba
    # # 注意：保留均值的符号，不做绝对值处理
    # use_ab_stats = df['mean_ab'].abs() > df['mean_ba'].abs()

    # # 初始化选中的均值和标准差
    # # df['mean_selected'] = np.where(use_ab_stats, df['mean_ab'], df['mean_ba'])
    # # df['std_selected'] = np.where(use_ab_stats, df['std_ab'], df['std_ba'])

    # # 计算两个价差的z-score（使用动态选择的统计量）
    # # df['z_score_ab'] = (df['spread_ab'] - df['mean_selected']) / df['std_selected']
    # # df['z_score_ba'] = (df['spread_ba'] - df['mean_selected']) / df['std_selected']

    # # 处理异常值
    # # df['z_score_ab'] = df['z_score_ab'].replace([np.inf, -np.inf], np.nan).fillna(0)
    # # df['z_score_ba'] = df['z_score_ba'].replace([np.inf, -np.inf], np.nan).fillna(0)

    # 新逻辑：根据 mean_ba 和 mean_ab 的符号决定如何计算 z-score
    # 情况1：开仓mean为负(mean_ba < 0)，平仓mean为正(mean_ab > 0)
    #   开仓：z_ba = (spread_ba + mean_ab) / std_ab  （开仓spread + 平仓mean）
    #   平仓：z_ab = (spread_ab - mean_ab) / std_ab  （平仓spread - 平仓mean）
    # 情况2：其他情况（开仓mean为正，平仓mean为负 OR 两个mean都为负）
    #   开仓：z_ba = (spread_ba - |mean_ab|) / std_ab  （开仓spread - |平仓mean|）
    #   平仓：z_ab = (spread_ab - mean_ab) / std_ab  （平仓spread - 平仓mean）

    condition_1 = (df['mean_ba'] < 0) & (df['mean_ab'] > 0)

    # 计算 z_score_ba（开仓用）
    df['z_score_ba'] = np.where(
        condition_1,
        (df['spread_ba'] + df['mean_ab']) / df['std_ab'],  # 情况1：加号
        (df['spread_ba'] - df['mean_ab'].abs()) / df['std_ab']  # 情况2：减去绝对值
    )

    # 计算 z_score_ab（平仓用）- 两种情况都一样
    df['z_score_ab'] = (df['spread_ab'] - df['mean_ab']) / df['std_ab']

    # 记录选中的统计量（用于CSV记录）
    df['mean_selected'] = df['mean_ab']
    df['std_selected'] = df['std_ab']

    # 处理异常值
    df['z_score_ab'] = df['z_score_ab'].replace([np.inf, -np.inf], np.nan).fillna(0)
    df['z_score_ba'] = df['z_score_ba'].replace([np.inf, -np.inf], np.nan).fillna(0)

    df = df.reset_index()
    return df


def simulate_trading_realistic(df, trade_size=1000, max_position=10000,
                               z_open=2.0, z_close=0.0):
    """
    真实交易模拟：基于bid/ask价格，包含成本计算

    记录每一次独立的交易动作（开仓或平仓）

    开仓：+a-b（买dex@ask，卖cex@bid）
    平仓：-a+b（卖dex@bid，买cex@ask）

    使用FIFO队列管理多个仓位

    成本计算：
    - CEX 手续费：0.036%
    - 反佣收入：手续费的 45%
    - DEX 滑点：0.02%
    """
    # 持仓队列（FIFO）
    open_positions = deque()
    current_position = 0

    trades = []  # 记录每一次交易动作
    equity_curve = []
    position_curve = []

    total_cash = 0
    cumulative_net_cash = 0  # 累计净现金流

    # 成本统计
    total_cex_fee = 0
    total_rebate = 0
    total_dex_slippage = 0

    # 交易量统计
    dex_volume_total = 0
    cex_volume_total = 0

    for i in range(len(df)):
        z_ab = df.loc[i, 'z_score_ab']
        z_ba = df.loc[i, 'z_score_ba']

        mean_ab = df.loc[i, 'mean_ab']
        std_ab = df.loc[i, 'std_ab']
        mean_ba = df.loc[i, 'mean_ba']
        std_ba = df.loc[i, 'std_ba']
        mean_selected = df.loc[i, 'mean_selected']
        std_selected = df.loc[i, 'std_selected']

        dex_bid = df.loc[i, 'dex_bid']
        dex_ask = df.loc[i, 'dex_ask']
        cex_bid = df.loc[i, 'cex_bid']
        cex_ask = df.loc[i, 'cex_ask']

        spread_ab = df.loc[i, 'spread_ab']
        spread_ba = df.loc[i, 'spread_ba']

        current_time = df.loc[i, 'timestamp']

        # ========== 开仓逻辑 ==========
        # 使用z_ba判断开仓，同时要求spread_ba > 0
        if z_ba >= z_open and spread_ba > 0 and current_position < max_position:
            quantity = trade_size

            # 实际交易
            buy_dex_cost = quantity * dex_ask
            sell_cex_income = quantity * cex_bid
            cashflow = sell_cex_income - buy_dex_cost

            # 成本计算
            cex_fee = abs(sell_cex_income) * CEX_FEE_RATE  # CEX 手续费
            rebate = cex_fee * REBATE_RATE  # 反佣收入
            dex_slippage = abs(buy_dex_cost) * DEX_SLIPPAGE_RATE  # DEX 滑点

            # 净现金流 = 原始现金流 - CEX手续费 - DEX滑点（不包含反佣）
            net_cashflow = cashflow - cex_fee - dex_slippage

            # 更新统计
            total_cash += cashflow
            cumulative_net_cash += net_cashflow
            current_position += quantity

            total_cex_fee += cex_fee
            total_rebate += rebate
            total_dex_slippage += dex_slippage

            # 交易量统计（单边）
            dex_volume_total += abs(buy_dex_cost)
            cex_volume_total += abs(sell_cex_income)

            # 记录开仓交易
            trades.append({
                'trade_id': len(trades) + 1,
                'time': pd.to_datetime(current_time, unit='ms'),
                'action': 'OPEN',
                'direction': '+a-b',
                'quantity': quantity,

                # 四个市场价格
                'dex_bid': dex_bid,
                'dex_ask': dex_ask,
                'cex_bid': cex_bid,
                'cex_ask': cex_ask,

                # 使用的价格
                'dex_price_used': dex_ask,
                'cex_price_used': cex_bid,
                'dex_action': 'BUY',
                'cex_action': 'SELL',

                # 原始现金流
                'dex_cashflow': -buy_dex_cost,
                'cex_cashflow': sell_cex_income,
                'total_cashflow': cashflow,

                # 成本
                'cex_fee': cex_fee,
                'rebate_income': rebate,
                'dex_slippage': dex_slippage,

                # 净现金流
                'net_cashflow': net_cashflow,
                'cumulative_net_cashflow': cumulative_net_cash,

                # 累计交易量
                'dex_volume_cumulative': dex_volume_total,
                'cex_volume_cumulative': cex_volume_total,

                # 市场状态
                'spread_ab': spread_ab,
                'spread_ba': spread_ba,
                'z_score_ab': z_ab,
                'z_score_ba': z_ba,
                'mean_ab': mean_ab,
                'std_ab': std_ab,
                'mean_ba': mean_ba,
                'std_ba': std_ba,
                'mean_selected': mean_selected,
                'std_selected': std_selected,

                # 仓位
                'position_after': current_position
            })

            # 保存到持仓队列（用于FIFO平仓）
            open_positions.append({
                'open_time': current_time,
                'quantity': quantity
            })

        # ========== 平仓逻辑 ==========
        elif z_ab >= z_close and len(open_positions) > 0:
            # FIFO平仓
            position_to_close = open_positions.popleft()
            quantity = position_to_close['quantity']

            # 实际交易
            sell_dex_income = quantity * dex_bid
            buy_cex_cost = quantity * cex_ask
            cashflow = sell_dex_income - buy_cex_cost

            # 成本计算
            cex_fee = abs(buy_cex_cost) * CEX_FEE_RATE  # CEX 手续费
            rebate = cex_fee * REBATE_RATE  # 反佣收入
            dex_slippage = abs(sell_dex_income) * DEX_SLIPPAGE_RATE  # DEX 滑点

            # 净现金流 = 原始现金流 - CEX手续费 - DEX滑点（不包含反佣）
            net_cashflow = cashflow - cex_fee - dex_slippage

            # 更新统计
            total_cash += cashflow
            cumulative_net_cash += net_cashflow
            current_position -= quantity

            total_cex_fee += cex_fee
            total_rebate += rebate
            total_dex_slippage += dex_slippage

            # 交易量统计（单边）
            dex_volume_total += abs(sell_dex_income)
            cex_volume_total += abs(buy_cex_cost)

            # 记录平仓交易
            trades.append({
                'trade_id': len(trades) + 1,
                'time': pd.to_datetime(current_time, unit='ms'),
                'action': 'CLOSE',
                'direction': '-a+b',
                'quantity': quantity,

                # 四个市场价格
                'dex_bid': dex_bid,
                'dex_ask': dex_ask,
                'cex_bid': cex_bid,
                'cex_ask': cex_ask,

                # 使用的价格
                'dex_price_used': dex_bid,
                'cex_price_used': cex_ask,
                'dex_action': 'SELL',
                'cex_action': 'BUY',

                # 原始现金流
                'dex_cashflow': sell_dex_income,
                'cex_cashflow': -buy_cex_cost,
                'total_cashflow': cashflow,

                # 成本
                'cex_fee': cex_fee,
                'rebate_income': rebate,
                'dex_slippage': dex_slippage,

                # 净现金流
                'net_cashflow': net_cashflow,
                'cumulative_net_cashflow': cumulative_net_cash,

                # 累计交易量
                'dex_volume_cumulative': dex_volume_total,
                'cex_volume_cumulative': cex_volume_total,

                # 市场状态
                'spread_ab': spread_ab,
                'spread_ba': spread_ba,
                'z_score_ab': z_ab,
                'z_score_ba': z_ba,
                'mean_ab': mean_ab,
                'std_ab': std_ab,
                'mean_ba': mean_ba,
                'std_ba': std_ba,
                'mean_selected': mean_selected,
                'std_selected': std_selected,

                # 仓位
                'position_after': current_position
            })

        # 记录净值和仓位
        equity_curve.append(total_cash)
        position_curve.append(current_position)

    # 添加列到df
    df['equity'] = equity_curve
    df['position'] = position_curve

    # 计算回撤
    df['equity_peak'] = df['equity'].cummax()
    df['drawdown'] = (df['equity'] - df['equity_peak']) / df['equity_peak'].abs() * 100

    trades_df = pd.DataFrame(trades)

    # 返回交易结果和成本统计
    cost_stats = {
        'total_cex_fee': total_cex_fee,
        'total_rebate': total_rebate,
        'total_dex_slippage': total_dex_slippage,
        'dex_volume_total': dex_volume_total,
        'cex_volume_total': cex_volume_total,
        'cumulative_net_cash': cumulative_net_cash
    }

    return df, trades_df, total_cash, cost_stats


def calculate_performance_metrics(trades_df, df, cumulative_net_cash):
    """计算性能指标"""
    metrics = {}

    metrics['cumulative_net_cash'] = cumulative_net_cash
    metrics['total_trades'] = len(trades_df)

    if len(trades_df) == 0:
        metrics['open_trades'] = 0
        metrics['close_trades'] = 0
        metrics['avg_cashflow'] = 0
        metrics['avg_open_cashflow'] = 0
        metrics['avg_close_cashflow'] = 0
        metrics['positive_cashflow_trades'] = 0
        metrics['negative_cashflow_trades'] = 0
        metrics['positive_rate'] = 0
        metrics['max_drawdown'] = 0
        return metrics

    # 交易类型统计
    open_trades = trades_df[trades_df['action'] == 'OPEN']
    close_trades = trades_df[trades_df['action'] == 'CLOSE']

    metrics['open_trades'] = len(open_trades)
    metrics['close_trades'] = len(close_trades)

    # 现金流统计
    metrics['avg_cashflow'] = trades_df['total_cashflow'].mean()
    metrics['avg_open_cashflow'] = open_trades['total_cashflow'].mean() if len(open_trades) > 0 else 0
    metrics['avg_close_cashflow'] = close_trades['total_cashflow'].mean() if len(close_trades) > 0 else 0

    positive_trades = trades_df[trades_df['total_cashflow'] > 0]
    negative_trades = trades_df[trades_df['total_cashflow'] < 0]

    metrics['positive_cashflow_trades'] = len(positive_trades)
    metrics['negative_cashflow_trades'] = len(negative_trades)
    metrics['positive_rate'] = (len(positive_trades) / len(trades_df)) * 100 if len(trades_df) > 0 else 0

    # 回撤
    metrics['max_drawdown'] = df['drawdown'].min()

    return metrics


def print_statistics(symbol, trades_df, metrics, df, cost_stats):
    """打印统计报告"""
    print(f"\n{'='*80}")
    print(f"真实交易模拟统计 - {symbol}")
    print(f"{'='*80}")

    print(f"\n【数据概况】")
    print(f"  数据点数: {len(df):,}")
    print(f"  时间跨度: {(df['timestamp'].max() - df['timestamp'].min()) / 60000:.1f} 分钟")

    print(f"\n【总收益】")
    print(f"  累计净现金流: {cost_stats['cumulative_net_cash']:+.2f}")
    print(f"  累计反佣收入: {cost_stats['total_rebate']:+.2f}")
    final_profit = cost_stats['cumulative_net_cash'] + cost_stats['total_rebate']
    print(f"  最终收益: {final_profit:+.2f}")

    print(f"\n【成本分析】")
    print(f"  总 CEX 手续费: {cost_stats['total_cex_fee']:.2f}")
    print(f"  总 DEX 滑点: {cost_stats['total_dex_slippage']:.2f}")
    print(f"  净成本: {cost_stats['total_cex_fee'] + cost_stats['total_dex_slippage']:.2f}")

    print(f"\n【交易量统计】")
    print(f"  DEX 总交易量: {cost_stats['dex_volume_total']:.2f}")
    print(f"  CEX 总交易量: {cost_stats['cex_volume_total']:.2f}")

    print(f"\n【交易统计】")
    print(f"  总交易次数: {metrics['total_trades']}")
    print(f"  开仓次数: {metrics['open_trades']}")
    print(f"  平仓次数: {metrics['close_trades']}")
    print(f"  正现金流交易: {metrics['positive_cashflow_trades']} ({metrics['positive_rate']:.2f}%)")
    print(f"  负现金流交易: {metrics['negative_cashflow_trades']}")

    print(f"\n【现金流分析】")
    print(f"  平均现金流: {metrics['avg_cashflow']:+.4f}")
    print(f"  开仓平均现金流: {metrics['avg_open_cashflow']:+.4f}")
    print(f"  平仓平均现金流: {metrics['avg_close_cashflow']:+.4f}")

    print(f"\n【风险指标】")
    print(f"  最大回撤: {metrics['max_drawdown']:.2f}%")

    if len(trades_df) > 0:
        print(f"\n【交易明细（前10笔）】")
        print("-" * 80)
        for _, trade in trades_df.head(10).iterrows():
            symbol_cf = "+" if trade['total_cashflow'] > 0 else "-"
            print(f"  #{trade['trade_id']} [{trade['action']}] {symbol_cf}")
            print(f"    时间: {trade['time'].strftime('%H:%M:%S.%f')[:-3]}")
            print(f"    方向: {trade['direction']} | {trade['dex_action']} DEX@{trade['dex_price_used']:.6f}, "
                  f"{trade['cex_action']} CEX@{trade['cex_price_used']:.6f}")
            print(f"    现金流: DEX={trade['dex_cashflow']:+.4f}, CEX={trade['cex_cashflow']:+.4f}, "
                  f"总计={trade['total_cashflow']:+.4f}")
            print(f"    市场: spread_ab={trade['spread_ab']:.2f}%, spread_ba={trade['spread_ba']:.2f}% | "
                  f"z_ab={trade['z_score_ab']:.2f}, z_ba={trade['z_score_ba']:.2f}")
            print(f"    统计: mean_ab={trade['mean_ab']:.2f}%, std_ab={trade['std_ab']:.2f}% | "
                  f"mean_ba={trade['mean_ba']:.2f}%, std_ba={trade['std_ba']:.2f}%")
            print(f"    使用: mean_sel={trade['mean_selected']:.2f}%, std_sel={trade['std_selected']:.2f}% | "
                  f"仓位后={trade['position_after']}")
            print()

    print(f"{'='*80}\n")


def plot_results(df, trades_df, symbol, metrics, output_dir):
    """绘制结果图表 - 只使用matplotlib交互式图表"""

    plot_results_matplotlib_interactive(df, trades_df, symbol, metrics, output_dir)


def plot_results_plotly(df, trades_df, symbol, metrics, output_dir):
    """绘制交互式结果图表"""

    # 创建子图 - 3行1列
    fig = make_subplots(
        rows=3, cols=1,
        subplot_titles=('Spreads Time Series', 'Z-Score Signals', 'Equity & Position'),
        vertical_spacing=0.08,
        specs=[[{"secondary_y": False}],
               [{"secondary_y": False}],
               [{"secondary_y": True}]]
    )

    # 子图1：价差时间序列
    fig.add_trace(
        go.Scatter(x=df.index, y=df['spread_ab'],
                   mode='lines', name='spread_ab (-a+b)',
                   line=dict(color='blue', width=1), opacity=0.7),
        row=1, col=1
    )
    fig.add_trace(
        go.Scatter(x=df.index, y=df['spread_ba'],
                   mode='lines', name='spread_ba (+a-b)',
                   line=dict(color='red', width=1), opacity=0.7),
        row=1, col=1
    )
    fig.add_trace(
        go.Scatter(x=df.index, y=df['mean_ab'],
                   mode='lines', name=f'{WINDOW_MIN}min Mean (spread_ab)',
                   line=dict(color='orange', width=2, dash='dash')),
        row=1, col=1
    )

    # 添加0线到第一个子图
    fig.add_hline(y=0, line=dict(color='black', width=1, dash='solid'),
                  opacity=0.5, row=1, col=1)

    # 子图2：Z-Scores
    fig.add_trace(
        go.Scatter(x=df.index, y=df['z_score_ab'],
                   mode='lines', name='z_score_ab',
                   line=dict(color='blue', width=1)),
        row=2, col=1
    )
    fig.add_trace(
        go.Scatter(x=df.index, y=df['z_score_ba'],
                   mode='lines', name='z_score_ba',
                   line=dict(color='red', width=1)),
        row=2, col=1
    )

    # 添加阈值线
    fig.add_hline(y=Z_OPEN, line=dict(color='green', width=2, dash='dash'),
                  row=2, col=1, annotation_text=f'Open ({Z_OPEN})')
    fig.add_hline(y=Z_CLOSE, line=dict(color='red', width=2, dash='dash'),
                  row=2, col=1, annotation_text=f'Close ({Z_CLOSE})')
    fig.add_hline(y=0, line=dict(color='black', width=1, dash='solid'),
                  opacity=0.3, row=2, col=1)

    # 子图3：净值曲线和仓位
    fig.add_trace(
        go.Scatter(x=df.index, y=df['equity'],
                   mode='lines', name='Equity',
                   line=dict(color='darkgreen', width=2)),
        row=3, col=1
    )

    # 添加0线
    fig.add_hline(y=0, line=dict(color='gray', width=1, dash='dash'),
                  opacity=0.5, row=3, col=1)

    # 仓位（使用第二个Y轴）
    fig.add_trace(
        go.Scatter(x=df.index, y=df['position'],
                   mode='lines', name='Position',
                   line=dict(color='purple', width=1.5), opacity=0.6),
        row=3, col=1, secondary_y=True
    )

    # 更新布局
    fig.update_layout(
        height=1200,
        title_text=f"{symbol} - Trading Backtest Analysis (Net Cashflow: {metrics['cumulative_net_cash']:+.2f})",
        showlegend=True,
        hovermode='x unified',
        template='plotly_white'
    )

    # 设置Y轴标题
    fig.update_yaxes(title_text="Spread (%)", row=1, col=1)
    fig.update_yaxes(title_text="Z-Score", row=2, col=1)
    fig.update_yaxes(title_text="Equity", row=3, col=1)
    fig.update_yaxes(title_text="Position (tokens)", secondary_y=True, row=3, col=1)

    # 设置X轴标题
    fig.update_xaxes(title_text="Data Point", row=3, col=1)

    # 设置X轴刻度间隔为1000
    fig.update_xaxes(tick0=0, dtick=1000)

    # 确保第一个子图的0刻度在中间 - 动态计算Y轴范围
    spread_min = min(df['spread_ab'].min(), df['spread_ba'].min())
    spread_max = max(df['spread_ab'].max(), df['spread_ba'].max())
    abs_max = max(abs(spread_min), abs(spread_max))
    fig.update_yaxes(range=[-abs_max*1.1, abs_max*1.1], row=1, col=1)

    # 设置Z-Score范围
    fig.update_yaxes(range=[-4, 6], row=2, col=1)

    # 保存为HTML文件（交互式）
    html_path = os.path.join(output_dir, f'{symbol}_interactive_backtest.html')
    fig.write_html(html_path)
    print(f"  交互式图表已保存: {html_path}")

    # 同时保存为PNG（静态）
    png_path = os.path.join(output_dir, f'{symbol}_realistic_backtest.png')
    fig.write_image(png_path, width=1600, height=1200, scale=2)
    print(f"  静态图表已保存: {png_path}")

    # 关闭图形对象
    fig.show()


def plot_results_bokeh(df, trades_df, symbol, metrics, output_dir):
    """使用Bokeh生成交互式图表"""
    from bokeh.plotting import figure, show, save, output_file
    from bokeh.models import HoverTool, ColumnDataSource, LinearAxis, Range1d
    from bokeh.layouts import column
    from bokeh.io import curdoc

    # 准备数据
    df_bokeh = df.copy()
    df_bokeh['index'] = df_bokeh.index.astype(str)

    # 创建ColumnDataSource
    source = ColumnDataSource(df_bokeh)

    # 工具提示
    hover_spread = HoverTool(tooltips=[
        ("Index", "$index"),
        ("Spread AB", "@spread_ab{0.0000}%"),
        ("Spread BA", "@spread_ba{0.0000}%"),
        ("Mean", "@mean_ab{0.0000}%")
    ])

    hover_zscore = HoverTool(tooltips=[
        ("Index", "$index"),
        ("Z-Score AB", "@z_score_ab{0.000}"),
        ("Z-Score BA", "@z_score_ba{0.000}")
    ])

    hover_equity = HoverTool(tooltips=[
        ("Index", "$index"),
        ("Equity", "@equity{0.00}"),
        ("Position", "@position{0}")
    ])

    # 子图1：价差时间序列
    p1 = figure(width=1200, height=300,
                title=f"{symbol} - Spreads Time Series",
                x_axis_label="Data Point", y_axis_label="Spread (%)",
                tools="pan,wheel_zoom,box_zoom,reset,save")

    # 确保Y轴0刻度居中
    spread_min = min(df['spread_ab'].min(), df['spread_ba'].min())
    spread_max = max(df['spread_ab'].max(), df['spread_ba'].max())
    abs_max = max(abs(spread_min), abs(spread_max))
    p1.y_range = Range1d(-abs_max*1.1, abs_max*1.1)

    line1 = p1.line('index', 'spread_ab', source=source, line_width=1, color='blue',
                    alpha=0.7, legend_label="spread_ab (-a+b)")
    line2 = p1.line('index', 'spread_ba', source=source, line_width=1, color='red',
                    alpha=0.7, legend_label="spread_ba (+a-b)")
    line3 = p1.line('index', 'mean_ab', source=source, line_width=2, color='orange',
                    line_dash='dashed', legend_label=f"{WINDOW_MIN}min Mean")

    # 添加0线
    zero_line = p1.line([df_bokeh['index'].iloc[0], df_bokeh['index'].iloc[-1]],
                        [0, 0], line_width=1, color='black', alpha=0.5)

    p1.add_tools(hover_spread)
    p1.legend.location = "top_left"

    # 子图2：Z-Scores
    p2 = figure(width=1200, height=300,
                title="Z-Score Signals",
                x_axis_label="Data Point", y_axis_label="Z-Score",
                x_range=p1.x_range,
                tools="pan,wheel_zoom,box_zoom,reset,save")

    line4 = p2.line('index', 'z_score_ab', source=source, line_width=1, color='blue',
                    legend_label="z_score_ab")
    line5 = p2.line('index', 'z_score_ba', source=source, line_width=1, color='red',
                    legend_label="z_score_ba")

    # 添加阈值线
    open_line = p2.line([df_bokeh['index'].iloc[0], df_bokeh['index'].iloc[-1]],
                        [Z_OPEN, Z_OPEN], line_width=2, color='green',
                        line_dash='dashed', legend_label=f"Open ({Z_OPEN})")
    close_line = p2.line([df_bokeh['index'].iloc[0], df_bokeh['index'].iloc[-1]],
                         [Z_CLOSE, Z_CLOSE], line_width=2, color='red',
                         line_dash='dashed', legend_label=f"Close ({Z_CLOSE})")
    zero_line2 = p2.line([df_bokeh['index'].iloc[0], df_bokeh['index'].iloc[-1]],
                         [0, 0], line_width=1, color='black', alpha=0.3)

    p2.y_range = Range1d(-4, 6)
    p2.add_tools(hover_zscore)
    p2.legend.location = "top_left"

    # 子图3：净值曲线和仓位
    p3 = figure(width=1200, height=300,
                title=f"Equity & Position (Net Cashflow: {metrics['cumulative_net_cash']:+.2f})",
                x_axis_label="Data Point", y_axis_label="Equity",
                x_range=p1.x_range,
                tools="pan,wheel_zoom,box_zoom,reset,save")

    # 净值曲线
    line6 = p3.line('index', 'equity', source=source, line_width=2, color='darkgreen',
                    legend_label="Equity")

    # 仓位（使用第二个Y轴）
    p3.extra_y_ranges = {"position": Range1d(start=df['position'].min()*1.1, end=df['position'].max()*1.1)}
    line7 = p3.line('index', 'position', source=source, line_width=1.5, color='purple',
                    alpha=0.6, y_range_name="position", legend_label="Position")

    # 添加0线
    zero_line3 = p3.line([df_bokeh['index'].iloc[0], df_bokeh['index'].iloc[-1]],
                         [0, 0], line_width=1, color='gray', line_dash='dashed', alpha=0.5)

    p3.add_layout(LinearAxis(y_range_name="position", axis_label="Position (tokens)"), 'right')
    p3.add_tools(hover_equity)
    p3.legend.location = "top_left"

    # 组合图表
    layout = column(p1, p2, p3)

    # 设置输出文件
    html_path = os.path.join(output_dir, f'{symbol}_bokeh_backtest.html')
    output_file(html_path, title=f"{symbol} - Trading Backtest Analysis")

    # 保存并显示
    save(layout)
    print(f"  Bokeh交互式图表已保存: {html_path}")

    # 同时生成静态PNG版本（使用matplotlib）
    plot_results_matplotlib(df, trades_df, symbol, metrics, output_dir)


def plot_results_matplotlib_interactive(df, trades_df, symbol, metrics, output_dir):
    """绘制matplotlib交互式图表（固定刻度，支持无限滑动）"""
    import matplotlib.pyplot as plt
    from matplotlib.widgets import Button
    import numpy as np

    # 启用交互模式
    plt.ion()

    # 创建超宽图表以包含所有数据点
    total_points = len(df)
    fig_width = max(96, total_points / 250)  # 进一步增加宽度，让100刻度间隔非常清晰
    fig = plt.figure(figsize=(fig_width, 12))

    # 调整子图间距，减少左边留白
    fig.subplots_adjust(hspace=0.3, left=0.02, right=0.98)

    # 设置窗口标题
    fig.canvas.manager.set_window_title(f'{symbol} - 可滑动交易图表 (固定刻度)')

    # 子图1：两个价差的时间序列（取绝对值显示）
    ax1 = plt.subplot(2, 1, 1)
    ax1.plot(df.index, df['spread_ab'].abs(), label='|spread_ab| (-a+b)', color='blue', linewidth=1, alpha=0.7)
    ax1.plot(df.index, df['spread_ba'].abs(), label='|spread_ba| (+a-b)', color='red', linewidth=1, alpha=0.7)
    ax1.plot(df.index, df['mean_ab'].abs(), label=f'|{WINDOW_MIN}min Mean (spread_ab)|',
             color='orange', linestyle='--', linewidth=2)

    # 添加spread_ab绝对值的中位线
    spread_ab_abs_median = df['spread_ab'].abs().median()
    ax1.axhline(y=spread_ab_abs_median, color='purple', linestyle='-', linewidth=2,
                label=f'|Median| ({spread_ab_abs_median:.4f}%)')

    # 添加0线
    ax1.axhline(y=0, color='black', linestyle='-', alpha=0.7, linewidth=2)

    # 计算绝对值的最大值用于设置Y轴范围，最小为2
    spread_ab_abs_max = df['spread_ab'].abs().max()
    spread_ba_abs_max = df['spread_ba'].abs().max()
    mean_ab_abs_max = df['mean_ab'].abs().max()
    abs_max = max(spread_ab_abs_max, spread_ba_abs_max, mean_ab_abs_max, 2)  # 最小为2
    ax1.set_ylim([0, abs_max])

    # 固定X轴刻度间隔为100
    ax1.xaxis.set_major_locator(plt.MultipleLocator(100))
    ax1.set_xlim(0, total_points)

    # 调整刻度标签字体和旋转，避免大数值重叠
    ax1.tick_params(axis='x', labelsize=8, rotation=45)
    ax1.xaxis.set_major_formatter(plt.FuncFormatter(lambda x, p: f'{int(x):,}'))

    # 标注交易点
    if len(trades_df) > 0:
        # 创建时间戳到索引的映射
        df_timestamps = df['timestamp'].values

        for idx, trade in trades_df.iterrows():
            # 将交易时间转换为毫秒时间戳
            if isinstance(trade['time'], str):
                trade_time_ms = int(pd.to_datetime(trade['time']).timestamp() * 1000)
            else:
                trade_time_ms = int(trade['time'].timestamp() * 1000)

            # 找到最接近的数据点索引
            closest_idx = np.argmin(np.abs(df_timestamps - trade_time_ms))

            # 获取交易信息
            action = trade['action']
            direction = trade['direction']
            spread_ab_val = trade['spread_ab']
            spread_ba_val = trade['spread_ba']

            # 根据direction选择对应的spread值和颜色（取绝对值）
            if direction == '+a-b':  # 开仓，使用spread_ba
                y_val = abs(spread_ba_val)
                color = 'green'
                marker_size = 40  # 开仓点稍大
            else:  # '-a+b' 平仓，使用spread_ab
                y_val = abs(spread_ab_val)
                color = 'red'
                marker_size = 50  # 平仓点更大，更明显

            # 根据action调整透明度
            alpha = 0.9 if action == 'OPEN' else 0.8

            # 在对应的spread线上标注交易点（使用实心圆点）
            ax1.scatter(closest_idx, y_val,
                        s=marker_size, marker='o',
                        color=color, alpha=alpha,
                        edgecolors='black', linewidths=0.5,  # 添加黑色边框让点更明显
                        label="",  # 不显示单个点的标签
                        zorder=10)  # 设置zorder确保圆圈在最上层

            # 不再添加交易编号，保持图表简洁

    ax1.set_title(f'{symbol} - |Spreads| Time Series (固定刻度，可滑动查看) + 交易点标注',
                  fontsize=14, fontweight='bold', pad=15)
    ax1.set_ylabel('|Spread| (%)', fontsize=11)

    # 获取现有的handles和labels
    handles, labels = ax1.get_legend_handles_labels()

    # 添加交易点的图例
    from matplotlib.lines import Line2D
    trade_elements = [
        Line2D([0], [0], marker='o', color='w', markerfacecolor='green',
               markeredgecolor='black', markersize=6, label='OPEN (+a-b)', alpha=0.9),
        Line2D([0], [0], marker='o', color='w', markerfacecolor='red',
               markeredgecolor='black', markersize=7, label='CLOSE (-a+b)', alpha=0.8)
    ]

    # 合并所有图例
    all_elements = handles + trade_elements
    ax1.legend(handles=all_elements, loc='upper left', fontsize=9, framealpha=0.9)
    ax1.grid(True, alpha=0.3, linestyle='-', linewidth=0.5)

    # 子图2：Z-Scores
    ax2 = plt.subplot(2, 1, 2)
    ax2.plot(df.index, df['z_score_ab'], label='z_score_ab', color='blue', linewidth=1)
    ax2.plot(df.index, df['z_score_ba'], label='z_score_ba', color='red', linewidth=1)
    ax2.axhline(y=Z_OPEN, color='green', linestyle='--', linewidth=2, label=f'Open ({Z_OPEN})')
    ax2.axhline(y=Z_CLOSE, color='red', linestyle='--', linewidth=2, label=f'Close ({Z_CLOSE})')
    ax2.axhline(y=0, color='black', linestyle='-', alpha=0.5, linewidth=1)

    # 固定X轴刻度间隔为100
    ax2.xaxis.set_major_locator(plt.MultipleLocator(100))
    ax2.set_xlim(0, total_points)
    ax2.set_ylim([-4, 6])

    # 调整刻度标签字体和旋转，避免大数值重叠
    ax2.tick_params(axis='x', labelsize=8, rotation=45)
    ax2.xaxis.set_major_formatter(plt.FuncFormatter(lambda x, p: f'{int(x):,}'))

    ax2.set_title('Z-Score Signals (固定刻度)', fontsize=14, fontweight='bold', pad=15)
    ax2.set_xlabel('Data Point (刻度间隔: 100)', fontsize=11)
    ax2.set_ylabel('Z-Score', fontsize=11)
    ax2.legend(loc='upper left', fontsize=9, framealpha=0.9)
    ax2.grid(True, alpha=0.3, linestyle='-', linewidth=0.5)

    # 添加操作说明
    fig.text(0.02, 0.98,
             f'📊 数据点总数: {total_points:,} | 刻度间隔: 100 | 使用鼠标拖动查看不同区域 | 滚轮缩放',
             transform=fig.transFigure, fontsize=10, verticalalignment='top',
             bbox=dict(boxstyle='round', facecolor='lightyellow', alpha=0.8))

    # 保存高质量静态版本
    output_path = os.path.join(output_dir, f'{symbol}_scrollable_backtest.png')
    plt.savefig(output_path, dpi=100, bbox_inches='tight', facecolor='white')
    print(f"  可滑动图表已保存: {output_path}")
    print(f"  📊 图表尺寸: {fig_width:.1f}x12 英寸，包含 {total_points:,} 个数据点")
    print(f"  🔧 刻度间隔: 100，已优化标签显示，可使用鼠标拖动查看任意区域")

    # 显示图表（交互模式）
    plt.show(block=True)  # 使用block=True保持窗口打开

    # 关闭图形对象
    plt.close(fig)


def plot_results_matplotlib(df, trades_df, symbol, metrics, output_dir):
    """绘制matplotlib静态结果图表（优化版）"""
    fig = plt.figure(figsize=(20, 12))

    # 子图1：两个价差的时间序列
    ax1 = plt.subplot(3, 1, 1)
    ax1.plot(df.index, df['spread_ab'], label='spread_ab (-a+b)', color='blue', linewidth=1, alpha=0.7)
    ax1.plot(df.index, df['spread_ba'], label='spread_ba (+a-b)', color='red', linewidth=1, alpha=0.7)
    ax1.plot(df.index, df['mean_ab'], label=f'{WINDOW_MIN}min Mean (spread_ab)',
             color='orange', linestyle='--', linewidth=2)

    # 添加0线并确保0刻度在中间
    ax1.axhline(y=0, color='black', linestyle='-', alpha=0.5, linewidth=1)
    # 计算绝对值的最大值用于设置Y轴范围，最小为2
    spread_min = min(df['spread_ab'].min(), df['spread_ba'].min())
    spread_max = max(df['spread_ab'].max(), df['spread_ba'].max())
    abs_max = max(abs(spread_min), abs(spread_max), 2)  # 最小为2
    ax1.set_ylim([-abs_max*1.1, abs_max*1.1])

    # 设置X轴刻度间隔为1000
    ax1.xaxis.set_major_locator(plt.MultipleLocator(100))

    ax1.set_title(f'{symbol} - Spreads Time Series', fontsize=14, fontweight='bold')
    ax1.set_ylabel('Spread (%)')
    ax1.legend(loc='upper left')
    ax1.grid(True, alpha=0.3)

    # 子图2：Z-Scores
    ax2 = plt.subplot(3, 1, 2)
    ax2.plot(df.index, df['z_score_ab'], label='z_score_ab', color='blue', linewidth=1)
    ax2.plot(df.index, df['z_score_ba'], label='z_score_ba', color='red', linewidth=1)
    ax2.axhline(y=Z_OPEN, color='green', linestyle='--', linewidth=2, label=f'Open ({Z_OPEN})')
    ax2.axhline(y=Z_CLOSE, color='red', linestyle='--', linewidth=2, label=f'Close ({Z_CLOSE})')
    ax2.axhline(y=0, color='black', linestyle='-', alpha=0.3, linewidth=0.5)

    # 设置X轴刻度间隔为1000
    ax2.xaxis.set_major_locator(plt.MultipleLocator(100))

    ax2.set_title('Z-Score Signals', fontsize=14, fontweight='bold')
    ax2.set_ylabel('Z-Score')
    ax2.legend(loc='upper left')
    ax2.grid(True, alpha=0.3)
    ax2.set_ylim([-4, 6])

    # 子图3：净值曲线和仓位
    ax3 = plt.subplot(3, 1, 3)
    ax3_twin = ax3.twinx()

    line1 = ax3.plot(df.index, df['equity'], label='Equity', color='darkgreen', linewidth=2)
    ax3.axhline(y=0, color='gray', linestyle='--', alpha=0.5)

    line2 = ax3_twin.plot(df.index, df['position'], label='Position',
                          color='purple', linewidth=1.5, alpha=0.6)

    # 设置X轴刻度间隔为1000
    ax3.xaxis.set_major_locator(plt.MultipleLocator(100))

    ax3.set_title(f'Equity & Position (Net Cashflow: {metrics["cumulative_net_cash"]:+.2f})',
                  fontsize=14, fontweight='bold')
    ax3.set_xlabel('Data Point')
    ax3.set_ylabel('Equity', color='darkgreen')
    ax3_twin.set_ylabel('Position (tokens)', color='purple')

    lines = line1 + line2
    labels = [l.get_label() for l in lines]
    ax3.legend(lines, labels, loc='upper left')
    ax3.grid(True, alpha=0.3)

    plt.tight_layout()
    output_path = os.path.join(output_dir, f'{symbol}_realistic_backtest.png')
    plt.savefig(output_path, dpi=150, bbox_inches='tight')
    print(f"  图表已保存: {output_path}")
    plt.close()


def main():
    """主函数"""
    # 解析命令行参数
    parser = argparse.ArgumentParser(description='真实交易模拟回测系统')
    parser.add_argument('--window_min', type=int, default=30, help='滚动窗口大小（分钟）')
    parser.add_argument('--z_open', type=float, default=1.0, help='开仓阈值')
    parser.add_argument('--z_close', type=float, default=0.0, help='平仓阈值')
    parser.add_argument('--symbols', type=str, default=None, help='指定处理的币种列表，用逗号分隔（如 BDXN-USDT,DAM-USDT），不指定则处理所有币种')
    args = parser.parse_args()

    # 使用传入的参数覆盖默认值
    global WINDOW_MIN, Z_OPEN, Z_CLOSE
    WINDOW_MIN = args.window_min
    Z_OPEN = args.z_open
    Z_CLOSE = args.z_close

    print("="*80)
    print("真实交易模拟回测系统")
    print("="*80)
    print(f"配置:")
    print(f"  数据目录: {DATA_DIR}")
    print(f"  输出目录: {OUTPUT_DIR}")
    print(f"  运行模式: {'随机抽样1小时' if USE_SAMPLING else '完整数据集'}")
    print(f"  滚动窗口: {WINDOW_MIN} 分钟")
    print(f"  开仓阈值: z >= {Z_OPEN}")
    print(f"  平仓阈值: z >= {Z_CLOSE}")
    print(f"  指定币种: {args.symbols if args.symbols else '所有币种'}")
    print(f"\n  成本参数:")
    print(f"    CEX 手续费率: {CEX_FEE_RATE*100:.3f}%")
    print(f"    反佣比例: {REBATE_RATE*100:.0f}%")
    print(f"    DEX 滑点: {DEX_SLIPPAGE_RATE*100:.2f}%")
    print(f"\n  币种配置:")
    for sym, cfg in SYMBOL_CONFIG.items():
        print(f"    {sym}: size={cfg['trade_size']}, max_position={cfg['max_position']}")
    print("="*80)
    # 创建输出目录
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    # 扫描数据目录或处理指定币种
    if args.symbols:
        # 解析逗号分隔的symbols列表
        symbol_list = [s.strip() for s in args.symbols.split(',') if s.strip()]
        target_files = []
        missing_symbols = []

        # 直接根据传入的symbols构建文件路径，并检查文件是否存在
        for symbol in symbol_list:
            target_file = os.path.join(DATA_DIR, f'{symbol}_prices.csv')
            if os.path.exists(target_file):  # ✅ 直接检查文件是否存在
                target_files.append(target_file)
            else:
                missing_symbols.append(symbol)

        if target_files:
            csv_files = target_files
            print(f"\n指定币种: {', '.join(symbol_list)}")
            if missing_symbols:
                print(f"警告: 未找到币种 {', '.join(missing_symbols)} 的数据文件！")
        else:
            print(f"\n错误: 未找到任何指定币种的数据文件！")
            print(f"请求的币种: {', '.join(symbol_list)}")
            return
    else:
        # 未指定symbols时，扫描所有文件
        csv_files = sorted(glob.glob(os.path.join(DATA_DIR, '*_prices.csv')))

    print(f"\n找到 {len(csv_files)} 个数据文件\n")

    if len(csv_files) == 0:
        print("错误: 未找到数据文件！")
        return

    summary = []

    for csv_file in csv_files:
        symbol = os.path.basename(csv_file).replace('_prices.csv', '')
        print(f"\n{'='*80}")
        print(f"处理币种: {symbol}")
        print(f"{'='*80}")

        try:
            # 读取数据
            print("  读取数据...")
            df = pd.read_csv(csv_file)
            print(f"  原始数据: {len(df):,} 行")

            # 根据配置选择抽样或全量数据
            if USE_SAMPLING:
                df_sample = sample_one_hour(df)
            else:
                df_sample = df.copy()
                start_time = pd.to_datetime(df_sample['timestamp'].min(), unit='ms')
                end_time = pd.to_datetime(df_sample['timestamp'].max(), unit='ms')
                duration_hours = (df_sample['timestamp'].max() - df_sample['timestamp'].min()) / (3600 * 1000)
                print(f"  时间范围: {start_time.strftime('%Y-%m-%d %H:%M:%S')} ~ {end_time.strftime('%Y-%m-%d %H:%M:%S')}")
                print(f"  数据跨度: {duration_hours:.2f} 小时")

            if len(df_sample) < 100:
                print("  警告: 数据点太少，跳过")
                continue

            # 获取币种配置
            if symbol in SYMBOL_CONFIG:
                trade_size = SYMBOL_CONFIG[symbol]['trade_size']
                max_position = SYMBOL_CONFIG[symbol]['max_position']
            else:
                continue
                # print(f"  警告: 未找到币种 {symbol} 的配置，使用默认值")
                # trade_size = 1000
                # max_position = 10000

            print(f"  交易参数: size={trade_size}, max_position={max_position}")

            # 计算价差和z-score[csv数据里补齐的]
            df_sample = calculate_spreads_and_zscore(df_sample, window_min=WINDOW_MIN)

            # 交易模拟
            print("  执行交易模拟...")
            df_result, trades_df, final_cash, cost_stats = simulate_trading_realistic(
                df_sample, trade_size, max_position, Z_OPEN, Z_CLOSE
            )

            # 计算指标
            metrics = calculate_performance_metrics(trades_df, df_result, cost_stats['cumulative_net_cash'])

            # 打印统计
            print_statistics(symbol, trades_df, metrics, df_result, cost_stats)

            # 绘图
            print("  生成图表...")
            plot_results(df_result, trades_df, symbol, metrics, OUTPUT_DIR)

            # 保存交易记录
            if len(trades_df) > 0:
                trades_path = os.path.join(OUTPUT_DIR, f'{symbol}_trades.csv')
                trades_df.to_csv(trades_path, index=False)
                print(f"  交易记录已保存: {trades_path}")

            # 汇总
            final_profit = cost_stats['cumulative_net_cash'] + cost_stats['total_rebate']
            summary.append({
                'symbol': symbol,
                'total_trades': metrics['total_trades'],
                'open_trades': metrics['open_trades'],
                'close_trades': metrics['close_trades'],
                'cumulative_net_cash': cost_stats['cumulative_net_cash'],
                'total_rebate': cost_stats['total_rebate'],
                'final_profit': final_profit,
                'cex_volume': cost_stats['cex_volume_total']
            })

        except Exception as e:
            print(f"  错误: {str(e)}")
            import traceback
            traceback.print_exc()
            continue

    # 保存汇总
    if summary:
        print("\n" + "="*80)
        print("所有币种汇总")
        print("="*80)
        summary_df = pd.DataFrame(summary)
        print(summary_df.to_string(index=False))
        print("="*80)

        summary_path = os.path.join(OUTPUT_DIR, 'realistic_summary.csv')
        summary_df.to_csv(summary_path, index=False)
        print(f"\n汇总已保存: {summary_path}")

    print("\n回测完成！")


if __name__ == '__main__':
    main()

import argparse
import glob
import os
import gc  # 导入垃圾回收模块，用于紧凑 c7i 实例的 14GiB 可用内存
import multiprocessing  # 使用底层多进程库，完美支持 max_tasks_per_child
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

# 固定滚动窗口（分钟）
WINDOW_MIN_LIST_FIXED = [10, 30, 60, 180, 360, 720]
DEFAULT_Z_OPEN_LIST_STR = "0,1,2,3,4"


@dataclass
class BacktestConfig:
    data_dir: str
    output_dir: str
    window_min: int
    min_periods: int
    z_open: float
    order_usd: float
    max_position_usd: float
    cooldown_ms: int
    funding_min: float
    fee_bps_total: float
    slippage_bps_total: float
    symbols: Optional[List[str]]
    z_open_list: List[float]
    z_open_ab_list: List[float]
    z_open_ba_list: List[float]
    window_min_list: List[int]


def parse_args() -> BacktestConfig:
    parser = argparse.ArgumentParser(
        description="CEX-CEX Netting backtest (Binance=A, Gate=B) - Optimized for c7i.2xlarge with 14G RAM"
    )
    parser.add_argument("--data_dir", default="./data/meta_data")
    parser.add_argument("--output_dir", default="./data/output_open_only")
    
    parser.add_argument("--window_min", type=int, default=30)
    parser.add_argument("--min_periods", type=int, default=30)
    parser.add_argument("--z_open", type=float, default=2.0)
    parser.add_argument(
        "--z_open_list",
        default=DEFAULT_Z_OPEN_LIST_STR,
        help="Comma separated z_open values, e.g. 1.2,1.5,2.0. If set, overrides default list."
    )
    parser.add_argument(
        "--z_open_ab_list",
        default=None,
        help="Comma separated z_open thresholds for -a+b direction. Default inherits --z_open_list."
    )
    parser.add_argument(
        "--z_open_ba_list",
        default=None,
        help="Comma separated z_open thresholds for +a-b direction. Default inherits --z_open_list."
    )
    parser.add_argument("--order_usd", type=float, default=100.0)
    parser.add_argument("--max_position_usd", type=float, default=2000.0)
    parser.add_argument("--cooldown_ms", type=int, default=1000)
    parser.add_argument(
        "--funding_min",
        type=float,
        default=-0.1,
        help="If either side funding rate is below this, do not open."
    )
    parser.add_argument("--fee_bps_total", type=float, default=4.0)
    parser.add_argument("--slippage_bps_total", type=float, default=4.0)
    parser.add_argument(
        "--symbols",
        default="",
        help="Comma separated symbols, e.g. BTCUSDT,ETHUSDT. Empty means all csv files."
    )
    args = parser.parse_args()

    symbols = [s.strip() for s in args.symbols.split(",") if s.strip()] or None
    z_open_list = [float(x.strip()) for x in args.z_open_list.split(",") if x.strip()]
    if args.z_open_ab_list and args.z_open_ab_list.strip():
        z_open_ab_list = [float(x.strip()) for x in args.z_open_ab_list.split(",") if x.strip()]
    else:
        z_open_ab_list = list(z_open_list)
    if args.z_open_ba_list and args.z_open_ba_list.strip():
        z_open_ba_list = [float(x.strip()) for x in args.z_open_ba_list.split(",") if x.strip()]
    else:
        z_open_ba_list = list(z_open_list)
        
    window_min_list = list(WINDOW_MIN_LIST_FIXED)
    return BacktestConfig(
        data_dir=args.data_dir,
        output_dir=args.output_dir,
        window_min=args.window_min,
        min_periods=args.min_periods,
        z_open=args.z_open,
        order_usd=args.order_usd,
        max_position_usd=args.max_position_usd,
        cooldown_ms=args.cooldown_ms,
        funding_min=args.funding_min,
        fee_bps_total=args.fee_bps_total,
        slippage_bps_total=args.slippage_bps_total,
        symbols=symbols,
        z_open_list=z_open_list,
        z_open_ab_list=z_open_ab_list,
        z_open_ba_list=z_open_ba_list,
        window_min_list=window_min_list,
    )


def pick_col(df: pd.DataFrame, candidates: List[str]) -> Optional[str]:
    for c in candidates:
        if c in df.columns:
            return c
    return None


def to_numeric(df: pd.DataFrame, cols: List[str]) -> None:
    for c in cols:
        if c in df.columns:
            df[c] = pd.to_numeric(df[c], errors="coerce")


def load_symbol_csv(path: str) -> pd.DataFrame:
    df = pd.read_csv(path)
    if "timestamp" not in df.columns:
        raise ValueError(f"{path} missing 'timestamp' column")
    df["timestamp"] = pd.to_numeric(df["timestamp"], errors="coerce")
    df = df.dropna(subset=["timestamp"]).copy()
    df["timestamp"] = df["timestamp"].astype(np.int64)
    df = df.sort_values("timestamp").reset_index(drop=True)

    numeric_candidates = [
        "spread_ab", "spread_ba",
        "cex_a_bid", "cex_a_ask", "cex_b_bid", "cex_b_ask",
        "binance_bid", "binance_ask", "gate_bid", "gate_ask",
        "binance_funding_rate", "gate_funding_rate",
    ]
    to_numeric(df, numeric_candidates)
    return df


def ensure_spreads(df: pd.DataFrame) -> pd.DataFrame:
    if "spread_ab" in df.columns and "spread_ba" in df.columns:
        return df

    a_bid_col = pick_col(df, ["cex_a_bid", "binance_bid"])
    a_ask_col = pick_col(df, ["cex_a_ask", "binance_ask"])
    b_bid_col = pick_col(df, ["cex_b_bid", "gate_bid"])
    b_ask_col = pick_col(df, ["cex_b_ask", "gate_ask"])

    if not all([a_bid_col, a_ask_col, b_bid_col, b_ask_col]):
        raise ValueError("Missing spread columns and cannot infer bid/ask columns.")

    df["spread_ab"] = (df[a_bid_col] - df[b_ask_col]) / df[b_ask_col] * 100.0
    df["spread_ba"] = (df[b_bid_col] - df[a_ask_col]) / df[a_ask_col] * 100.0
    return df


def resolve_price_cols(df: pd.DataFrame) -> Tuple[str, str, str, str]:
    a_bid_col = pick_col(df, ["cex_a_bid", "binance_bid"])
    a_ask_col = pick_col(df, ["cex_a_ask", "binance_ask"])
    b_bid_col = pick_col(df, ["cex_b_bid", "gate_bid"])
    b_ask_col = pick_col(df, ["cex_b_ask", "gate_ask"])
    if not all([a_bid_col, a_ask_col, b_bid_col, b_ask_col]):
        raise ValueError("Missing bid/ask columns for A(Binance) and B(Gate).")
    return a_bid_col, a_ask_col, b_bid_col, b_ask_col


def compute_signal_features(df: pd.DataFrame, cfg: BacktestConfig, current_window_min: int) -> pd.DataFrame:
    out = df.copy()

    total_cost_pct = (cfg.fee_bps_total + cfg.slippage_bps_total) / 100.0
    out["spread_ab_adj"] = out["spread_ab"] - total_cost_pct
    out["spread_ba_adj"] = out["spread_ba"] - total_cost_pct

    win = f"{current_window_min}min"
    out["dt"] = pd.to_datetime(out["timestamp"], unit="ms")
    out = out.set_index("dt")

    # 信号统计使用原始价差（不扣成本）
    out["median_ab"] = out["spread_ab"].rolling(win, min_periods=cfg.min_periods).median()
    out["median_ba"] = out["spread_ba"].rolling(win, min_periods=cfg.min_periods).median()

    out["mad_ab"] = (
        (out["spread_ab"] - out["median_ab"]).abs()
        .rolling(win, min_periods=cfg.min_periods).median()
    )
    out["mad_ba"] = (
        (out["spread_ba"] - out["median_ba"]).abs()
        .rolling(win, min_periods=cfg.min_periods).median()
    )

    out["mad_ab"] = out["mad_ab"].replace(0, np.nan)
    out["mad_ba"] = out["mad_ba"].replace(0, np.nan)

    out["z_ab"] = (out["spread_ab_adj"] - out["median_ab"]) / out["mad_ab"]
    out["z_ba"] = (out["spread_ba_adj"] - out["median_ba"]) / out["mad_ba"]

    return out.reset_index(drop=False)


def simulate_open_only(
    df: pd.DataFrame,
    symbol: str,
    cfg: BacktestConfig,
    current_z_open_ab: float,
    current_z_open_ba: float,
) -> Dict:
    funding_a_col = pick_col(df, ["binance_funding_rate"])
    funding_b_col = pick_col(df, ["gate_funding_rate"])
    a_bid_col, a_ask_col, b_bid_col, b_ask_col = resolve_price_cols(df)

    # 分腿仓位（数量）
    # -a+b: A 数量仓位 -qty, B 数量仓位 +qty
    # +a-b: A 数量仓位 +qty, B 数量仓位 -qty
    a_pos_qty = 0.0
    b_pos_qty = 0.0
    max_seen_position_qty = 0.0
    
    last_order_ts = -10**18
    trade_id = 0
    orders_side_ab = 0  
    orders_side_ba = 0  

    blocked_by_funding = 0
    blocked_by_rate_limit = 0
    blocked_by_position = 0
    clipped_by_position = 0
    blocked_by_spread_filter = 0  # 新增统计：因价差不符硬性条件而被过滤的次数
    evaluated_points = 0
    
    profit_total = 0.0
    open_profit_total = 0.0
    fee_rate_total = (cfg.fee_bps_total + cfg.slippage_bps_total) / 10000.0  # 默认万8
    fee_rate_per_leg = fee_rate_total / 2.0
    total_adj_spread_pct = 0.0
    # 两套未对冲持仓分层（FIFO / LIFO）用于回滚口径
    # 每层结构: {"direction": "+a-b"/"-a+b", "qty": float, "a_px": float, "b_px": float}
    open_lots_fifo: List[Dict] = []
    open_lots_lifo: List[Dict] = []

    def normalize_qty(qty: float) -> float:
        return float(np.round(qty, 12))

    def calc_close_profit(close_qty: float, a_px_close: float, b_px_close: float, side: str) -> float:
        if close_qty <= 1e-12:
            return 0.0
        if not np.isfinite(a_px_close) or not np.isfinite(b_px_close) or a_px_close <= 0 or b_px_close <= 0:
            return 0.0
        if side == "-a+b":
            gross_close = close_qty * b_px_close - close_qty * a_px_close
        else:
            gross_close = close_qty * a_px_close - close_qty * b_px_close
        close_fee = (abs(close_qty * a_px_close) * fee_rate_per_leg) + (abs(close_qty * b_px_close) * fee_rate_per_leg)
        return gross_close - close_fee

    def add_open_lot(book: List[Dict], direction: str, qty: float, a_px: float, b_px: float, mode: str) -> None:
        remaining = qty
        while remaining > 1e-12 and book:
            idx = 0 if mode == "fifo" else -1
            head = book[idx]
            if head["direction"] == direction:
                break
            consume = min(remaining, head["qty"])
            head["qty"] -= consume
            remaining -= consume
            if head["qty"] <= 1e-12:
                if mode == "fifo":
                    book.pop(0)
                else:
                    book.pop()
        if remaining > 1e-12:
            book.append(
                {
                    "direction": direction,
                    "qty": remaining,
                    "a_px": float(a_px),
                    "b_px": float(b_px),
                }
            )

    def interval_for_leg(pos: float, delta_sign: int, limit: float) -> Tuple[float, float]:
        if delta_sign == 1:
            low = -limit - pos
            high = limit - pos
        else:
            low = pos - limit
            high = pos + limit
        return low, high

    def max_feasible_qty(pos_a: float, pos_b: float, limit: float, delta_a: int, delta_b: int) -> float:
        low_a, high_a = interval_for_leg(pos_a, delta_a, limit)
        low_b, high_b = interval_for_leg(pos_b, delta_b, limit)
        low = max(0.0, low_a, low_b)
        high = min(high_a, high_b)
        if high < low:
            return 0.0
        return max(0.0, high)

    for _, row in df.iterrows():
        ts = int(row["timestamp"])
        evaluated_points += 1

        if pd.isna(row["z_ab"]) or pd.isna(row["z_ba"]):
            continue

        if ts - last_order_ts < cfg.cooldown_ms:
            blocked_by_rate_limit += 1
            continue

        funding_a = row[funding_a_col] if funding_a_col else np.nan
        funding_b = row[funding_b_col] if funding_b_col else np.nan
        if (
            pd.isna(funding_a)
            or pd.isna(funding_b)
            or funding_a < cfg.funding_min
            or funding_b < cfg.funding_min
        ):
            blocked_by_funding += 1
            continue

        can_open_ab = row["z_ab"] >= current_z_open_ab
        can_open_ba = row["z_ba"] >= current_z_open_ba
        if not can_open_ab and not can_open_ba:
            continue

        if can_open_ab and can_open_ba:
            direction = "-a+b" if row["z_ab"] >= row["z_ba"] else "+a-b"
        elif can_open_ab:
            direction = "-a+b"
        else:
            direction = "+a-b"

        # 确定本次开仓使用的扣费/滑点后实际可用价差
        adj_spread = row["spread_ab_adj"] if direction == "-a+b" else row["spread_ba_adj"]

        # ─── 硬性限制条件：扣费后净价差必须在 [0.0%, 10.0%] 区间内 ───
        # 排除因交易所插针、宕机维护、数据污染产生的负价差或超大畸形异常价差
        if not (0.0 <= adj_spread <= 10.0):
            blocked_by_spread_filter += 1
            continue

        if direction == "-a+b":
            a_px = float(row[a_bid_col])  # A 卖出（开空）价格
            b_px = float(row[b_ask_col])  # B 买入（开多）价格
            if not np.isfinite(a_px) or not np.isfinite(b_px) or a_px <= 0 or b_px <= 0:
                continue

            qty = normalize_qty(cfg.order_usd / a_px)
            max_position_qty = cfg.max_position_usd / a_px
            max_allowed = max_feasible_qty(a_pos_qty, b_pos_qty, max_position_qty, delta_a=-1, delta_b=1)
            if max_allowed <= 1e-12:
                blocked_by_position += 1
                continue
            if qty > max_allowed:
                qty = normalize_qty(max_allowed)
                clipped_by_position += 1
            if qty <= 1e-12:
                blocked_by_position += 1
                continue

            a_leg_value = qty * a_px
            b_leg_value = qty * b_px
            gross_profit = a_leg_value - b_leg_value
            fee_cost = abs(a_leg_value) * fee_rate_per_leg + abs(b_leg_value) * fee_rate_per_leg
            trade_profit = gross_profit - fee_cost

            orders_side_ab += 1
            a_pos_qty -= qty
            b_pos_qty += qty
        else:
            a_px = float(row[a_ask_col])  # A 买入（开多）价格
            b_px = float(row[b_bid_col])  # B 卖出（开空）价格
            if not np.isfinite(a_px) or not np.isfinite(b_px) or a_px <= 0 or b_px <= 0:
                continue

            qty = normalize_qty(cfg.order_usd / a_px)
            max_position_qty = cfg.max_position_usd / a_px
            max_allowed = max_feasible_qty(a_pos_qty, b_pos_qty, max_position_qty, delta_a=1, delta_b=-1)
            if max_allowed <= 1e-12:
                blocked_by_position += 1
                continue
            if qty > max_allowed:
                qty = normalize_qty(max_allowed)
                clipped_by_position += 1
            if qty <= 1e-12:
                blocked_by_position += 1
                continue

            a_leg_value = qty * a_px
            b_leg_value = qty * b_px
            gross_profit = b_leg_value - a_leg_value
            fee_cost = abs(a_leg_value) * fee_rate_per_leg + abs(b_leg_value) * fee_rate_per_leg
            trade_profit = gross_profit - fee_cost

            orders_side_ba += 1
            a_pos_qty += qty
            b_pos_qty -= qty

        max_seen_position_qty = max(max_seen_position_qty, abs(a_pos_qty), abs(b_pos_qty))
        add_open_lot(open_lots_fifo, direction, qty, a_px, b_px, mode="fifo")
        add_open_lot(open_lots_lifo, direction, qty, a_px, b_px, mode="lifo")
        trade_id += 1
        last_order_ts = ts
        profit_total += trade_profit
        open_profit_total += trade_profit
        total_adj_spread_pct += adj_spread

    # 回测结束后三种强平/回滚口径：
    # 1) last_tick
    # 2) rollback_unopened_fifo
    # 3) rollback_unopened_lifo
    close_profit_last_tick = 0.0
    close_profit_rollback_unopened_fifo = 0.0
    close_profit_rollback_unopened_lifo = 0.0
    if len(df) > 0 and (abs(a_pos_qty) > 1e-12 or abs(b_pos_qty) > 1e-12):
        last = df.iloc[-1]
        close_qty = min(abs(a_pos_qty), abs(b_pos_qty))
        if close_qty > 1e-12:
            if a_pos_qty < 0:
                side = "-a+b"
                # last tick 反向平仓价格：A 回补 ask，B 平多 bid
                a_last_tick_px = float(last[a_ask_col])
                b_last_tick_px = float(last[b_bid_col])
            elif a_pos_qty > 0:
                side = "+a-b"
                # last tick 反向平仓价格：A 平多 bid，B 回补 ask
                a_last_tick_px = float(last[a_bid_col])
                b_last_tick_px = float(last[b_ask_col])
            else:
                side = ""
                a_last_tick_px = np.nan
                b_last_tick_px = np.nan

            close_profit_last_tick = calc_close_profit(close_qty, a_last_tick_px, b_last_tick_px, side)

            # rollback FIFO
            lots_for_side_fifo = [lot for lot in open_lots_fifo if lot["direction"] == side and lot["qty"] > 1e-12]
            rollback_amount_fifo = 0.0
            for lot in lots_for_side_fifo:
                q = float(lot["qty"])
                a_open = float(lot["a_px"])
                b_open = float(lot["b_px"])
                if side == "-a+b":
                    gross_open = q * a_open - q * b_open
                else:
                    gross_open = q * b_open - q * a_open
                fee_open = abs(q * a_open) * fee_rate_per_leg + abs(q * b_open) * fee_rate_per_leg
                rollback_amount_fifo += (gross_open - fee_open)
            close_profit_rollback_unopened_fifo = -rollback_amount_fifo

            # rollback LIFO
            lots_for_side_lifo = [lot for lot in open_lots_lifo if lot["direction"] == side and lot["qty"] > 1e-12]
            rollback_amount_lifo = 0.0
            for lot in lots_for_side_lifo:
                q = float(lot["qty"])
                a_open = float(lot["a_px"])
                b_open = float(lot["b_px"])
                if side == "-a+b":
                    gross_open = q * a_open - q * b_open
                else:
                    gross_open = q * b_open - q * a_open
                fee_open = abs(q * a_open) * fee_rate_per_leg + abs(q * b_open) * fee_rate_per_leg
                rollback_amount_lifo += (gross_open - fee_open)
            close_profit_rollback_unopened_lifo = -rollback_amount_lifo

        # 主汇总字段默认使用 last_tick 口径
        profit_total += close_profit_last_tick
        a_pos_qty = 0.0
        b_pos_qty = 0.0

    profit_total_last_tick = open_profit_total + close_profit_last_tick
    profit_total_rollback_unopened_fifo = open_profit_total + close_profit_rollback_unopened_fifo
    profit_total_rollback_unopened_lifo = open_profit_total + close_profit_rollback_unopened_lifo

    summary = {
        "symbol": symbol,
        "rows": len(df),
        "orders": trade_id,
        "orders_side_ab": orders_side_ab,
        "orders_side_ba": orders_side_ba,
        "final_a_position_qty": a_pos_qty,
        "final_b_position_qty": b_pos_qty,
        "max_seen_position_qty": max_seen_position_qty,
        "max_orders_capacity": int(cfg.max_position_usd // cfg.order_usd),
        "open_profit_usd_total": open_profit_total,
        "close_profit_usd_total": close_profit_last_tick,
        "profit_usd_total": profit_total_last_tick,
        "close_profit_last_tick": close_profit_last_tick,
        "close_profit_rollback_unopened_fifo": close_profit_rollback_unopened_fifo,
        "close_profit_rollback_unopened_lifo": close_profit_rollback_unopened_lifo,
        "profit_usd_total_last_tick": profit_total_last_tick,
        "profit_usd_total_rollback_unopened_fifo": profit_total_rollback_unopened_fifo,
        "profit_usd_total_rollback_unopened_lifo": profit_total_rollback_unopened_lifo,
        "avg_adj_spread_pct": float(total_adj_spread_pct / trade_id) if trade_id > 0 else 0.0,
        "blocked_by_funding": blocked_by_funding,
        "blocked_by_rate_limit": blocked_by_rate_limit,
        "blocked_by_position": blocked_by_position,
        "clipped_by_position": clipped_by_position,
        "blocked_by_spread_filter": blocked_by_spread_filter,
        "evaluated_points": evaluated_points,
    }
    return summary


def pick_input_files(cfg: BacktestConfig) -> List[str]:
    files = sorted(glob.glob(os.path.join(cfg.data_dir, "*.csv")))
    if not cfg.symbols:
        return files

    symbol_set = set(cfg.symbols)
    picked = []
    for f in files:
        symbol = os.path.splitext(os.path.basename(f))[0]
        if symbol in symbol_set:
            picked.append(f)
    return picked


def process_single_file(file_info: tuple) -> list:
    path, cfg, file_idx, total_files = file_info
    symbol = os.path.splitext(os.path.basename(path))[0]
    file_summaries = []
    
    print(f"[PROCESS] 进程分配成功: [{file_idx}/{total_files}] 正在算 {symbol}")
    
    try:
        raw_data = load_symbol_csv(path)
        raw_data = ensure_spreads(raw_data)
    except Exception as exc:
        print(f"[ERROR] 读取文件失败 {symbol}: {exc}")
        return []

    for window_min_value in cfg.window_min_list:
        features = compute_signal_features(raw_data, cfg, current_window_min=window_min_value)

        for z_open_ab_value in cfg.z_open_ab_list:
            for z_open_ba_value in cfg.z_open_ba_list:
                try:
                    summary = simulate_open_only(
                        features,
                        symbol,
                        cfg,
                        current_z_open_ab=z_open_ab_value,
                        current_z_open_ba=z_open_ba_value,
                    )
                    summary["window_min"] = window_min_value
                    summary["z_open_ab"] = z_open_ab_value
                    summary["z_open_ba"] = z_open_ba_value
                    file_summaries.append(summary)
                except Exception as exc:
                    print(
                        f"[ERROR] 策略出错 {symbol} w={window_min_value}, "
                        f"z_ab={z_open_ab_value}, z_ba={z_open_ba_value}: {exc}"
                    )
                
    print(f"[SUCCESS] 完成处理: {symbol}，生成组合记录 {len(file_summaries)} 条")
    
    del raw_data
    if 'features' in locals():
        del features
    gc.collect() 
    
    return file_summaries


def main():
    cfg = parse_args()
    files = pick_input_files(cfg)
    if not files:
        print(f"[ERROR] no csv files found in {cfg.data_dir} with symbols={cfg.symbols}")
        return

    TARGET_WORKERS = 2 
    total_files_count = len(files)
    
    print(
        f"[START] AWS c7i.2xlarge 内存防护追加版系统启动 | 锁定核心数: {TARGET_WORKERS}\n"
        f"数据读取目录: {cfg.data_dir} | 结果输出目录: {cfg.output_dir}\n"
        f"待扫描文件数: {total_files_count} | 参数复杂度: {len(cfg.window_min_list)} 窗口 × "
        f"{len(cfg.z_open_ab_list)}(z_ab阈值) × {len(cfg.z_open_ba_list)}(z_ba阈值)"
    )

    tasks = [(f, cfg, i, total_files_count) for i, f in enumerate(files, 1)]
    
    os.makedirs(cfg.output_dir, exist_ok=True)
    summary_path = os.path.join(cfg.output_dir, "summary_open_only.csv")
    
    if os.path.exists(summary_path):
        os.remove(summary_path)

    cols_order = [
        "symbol", "window_min", "z_open_ab", "z_open_ba", "orders",
        "orders_side_ab", "orders_side_ba", 
        "open_profit_usd_total",
        "close_profit_usd_total", "profit_usd_total",
        "close_profit_last_tick",
        "close_profit_rollback_unopened_fifo", "close_profit_rollback_unopened_lifo",
        "profit_usd_total_last_tick",
        "profit_usd_total_rollback_unopened_fifo", "profit_usd_total_rollback_unopened_lifo",
        "max_seen_position_qty", "final_a_position_qty", "final_b_position_qty"
    ]

    ctx = multiprocessing.get_context("spawn")
    completed_count = 0

    with ctx.Pool(processes=TARGET_WORKERS, maxtasksperchild=2) as pool:
        try:
            for res_list in pool.imap_unordered(process_single_file, tasks):
                if not res_list:
                    completed_count += 1
                    print(f"[PROGRESS] ▓▓ 任务进度: {completed_count}/{total_files_count} | 某个文件执行失败跳过")
                    continue
                
                completed_count += 1
                current_symbol = res_list[0]['symbol']
                
                df_chunk = pd.DataFrame(res_list)
                remaining_cols = [c for c in df_chunk.columns if c not in cols_order]
                df_chunk = df_chunk[cols_order + remaining_cols]
                
                is_first_write = not os.path.exists(summary_path)
                df_chunk.to_csv(summary_path, mode='a', index=False, header=is_first_write)
                
                print(
                    f"[PROGRESS] ▓▓ 任务进度: {completed_count}/{total_files_count} | "
                    f"💾 刚刚成功写入: {current_symbol}"
                )
                
        except Exception as e:
            print(f"\n[FATAL ERROR] 捕获到多进程异常: {e}")
            return

    print(f"\n[DONE] c7i.2xlarge 回测全部安全跑完！最终完整报告已安全保存在: {summary_path}")


if __name__ == "__main__":
    main()

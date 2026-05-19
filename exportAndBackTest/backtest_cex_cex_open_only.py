import argparse
import glob
import os
import gc  # 导入垃圾回收模块，用于释放 c7i.2xlarge 的 16GiB 内存
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple
from concurrent.futures import ProcessPoolExecutor  # 导入多进程核心库

import numpy as np
import pandas as pd

# 固定滚动窗口（分钟）
WINDOW_MIN_LIST_FIXED = [10, 30, 60, 180, 360, 720]


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
    window_min_list: List[int]


def parse_args() -> BacktestConfig:
    parser = argparse.ArgumentParser(
        description="CEX-CEX open-only backtest (Binance=A, Gate=B) - Optimized for c7i.2xlarge"
    )
    parser.add_argument("--data_dir", default="./data/meta_data")
    parser.add_argument("--output_dir", default="./data/output_open_only")
    parser.add_argument("--window_min", type=int, default=30)
    parser.add_argument("--min_periods", type=int, default=30)
    parser.add_argument("--z_open", type=float, default=2.0)
    parser.add_argument(
        "--z_open_list",
        default="",
        help="Comma separated z_open values, e.g. 1.2,1.5,2.0. If set, overrides default list."
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
    if args.z_open_list.strip():
        z_open_list = [float(x.strip()) for x in args.z_open_list.split(",") if x.strip()]
    else:
        z_open_list = [0.0, 1.0, 2.0, 3.0, 4.0]
        
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


def compute_signal_features(df: pd.DataFrame, cfg: BacktestConfig, current_window_min: int) -> pd.DataFrame:
    out = df.copy()

    total_cost_pct = (cfg.fee_bps_total + cfg.slippage_bps_total) / 100.0
    out["spread_ab_adj"] = out["spread_ab"] - total_cost_pct
    out["spread_ba_adj"] = out["spread_ba"] - total_cost_pct

    win = f"{current_window_min}min"
    out["dt"] = pd.to_datetime(out["timestamp"], unit="ms")
    out = out.set_index("dt")

    out["median_ab"] = out["spread_ab_adj"].rolling(win, min_periods=cfg.min_periods).median()
    out["median_ba"] = out["spread_ba_adj"].rolling(win, min_periods=cfg.min_periods).median()

    out["mad_ab"] = (
        (out["spread_ab_adj"] - out["median_ab"]).abs()
        .rolling(win, min_periods=cfg.min_periods).median()
    )
    out["mad_ba"] = (
        (out["spread_ba_adj"] - out["median_ba"]).abs()
        .rolling(win, min_periods=cfg.min_periods).median()
    )

    # 如果 MAD 为 0，不准确，直接替换为 NaN。后续仿真直接跳过
    out["mad_ab"] = out["mad_ab"].replace(0, np.nan)
    out["mad_ba"] = out["mad_ba"].replace(0, np.nan)

    out["z_ab"] = (out["spread_ab_adj"] - out["median_ab"]) / out["mad_ab"]
    out["z_ba"] = (out["spread_ba_adj"] - out["median_ba"]) / out["mad_ba"]

    return out.reset_index(drop=False)


def simulate_open_only(df: pd.DataFrame, symbol: str, cfg: BacktestConfig, current_z_open: float) -> Dict:
    funding_a_col = pick_col(df, ["binance_funding_rate"])
    funding_b_col = pick_col(df, ["gate_funding_rate"])

    pos_usd = 0.0
    last_order_ts = -10**18
    trade_id = 0
    
    # 每次调用该参数节点时，计数器会彻底重置清零
    orders_side_ab = 0  
    orders_side_ba = 0  

    blocked_by_funding = 0
    blocked_by_rate_limit = 0
    blocked_by_position = 0
    evaluated_points = 0
    
    profit_total = 0.0
    total_adj_spread_pct = 0.0

    for _, row in df.iterrows():
        ts = int(row["timestamp"])
        evaluated_points += 1

        # 若 z_score 为 NaN (对应 MAD 为 0 或历史点数不够)，不准确，直接跳过
        if pd.isna(row["z_ab"]) or pd.isna(row["z_ba"]):
            continue

        if pos_usd + cfg.order_usd > cfg.max_position_usd:
            blocked_by_position += 1
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

        can_open_ab = row["z_ab"] >= current_z_open
        can_open_ba = row["z_ba"] >= current_z_open
        if not can_open_ab and not can_open_ba:
            continue

        if can_open_ab and can_open_ba:
            direction = "-a+b" if row["z_ab"] >= row["z_ba"] else "+a-b"
        elif can_open_ab:
            direction = "-a+b"
        else:
            direction = "+a-b"

        # 统计独立方向
        if direction == "-a+b":
            orders_side_ab += 1
            adj_spread = row["spread_ab_adj"]
        else:
            orders_side_ba += 1
            adj_spread = row["spread_ba_adj"]

        expected_edge_usd = cfg.order_usd * adj_spread / 100.0

        trade_id += 1
        pos_usd += cfg.order_usd
        last_order_ts = ts
        
        profit_total += expected_edge_usd
        total_adj_spread_pct += adj_spread

    summary = {
        "symbol": symbol,
        "rows": len(df),
        "orders": trade_id,
        "orders_side_ab": orders_side_ab,
        "orders_side_ba": orders_side_ba,
        "final_position_usd": pos_usd,
        "max_orders_capacity": int(cfg.max_position_usd // cfg.order_usd),
        "profit_usd_total": profit_total,
        "avg_adj_spread_pct": float(total_adj_spread_pct / trade_id) if trade_id > 0 else 0.0,
        "blocked_by_funding": blocked_by_funding,
        "blocked_by_rate_limit": blocked_by_rate_limit,
        "blocked_by_position": blocked_by_position,
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
    """
    单个核心并行的执行体：单独加载、计算单币种的全部窗口和Z轴组合
    """
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

        for z_open_value in cfg.z_open_list:
            try:
                summary = simulate_open_only(
                    features, 
                    symbol, 
                    cfg, 
                    current_z_open=z_open_value
                )
                summary["window_min"] = window_min_value
                summary["z_open"] = z_open_value
                file_summaries.append(summary)
            except Exception as exc:
                print(f"[ERROR] 组合计算出错 {symbol} w={window_min_value}, z={z_open_value}: {exc}")
                
    print(f"[SUCCESS] 完成处理: {symbol}，生成组合记录 {len(file_summaries)} 条")
    
    # 显式清理，降低 c7i 实例 16GiB 内存被爆掉的概率
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

    # 完美压榨 c7i.2xlarge 的 8 个 vCPU
    TARGET_WORKERS = 8 
    
    print(
        f"[START] AWS c7i.2xlarge 专属多进程回测启动 | 锁定并行核心数: {TARGET_WORKERS}\n"
        f"待处理币种文件数: {len(files)} | 参数广度: {len(cfg.window_min_list)} 窗口 × {len(cfg.z_open_list)} 阈值"
    )

    tasks = [(f, cfg, i, len(files)) for i, f in enumerate(files, 1)]
    all_summaries = []
    
    # 启动多进程池
    with ProcessPoolExecutor(max_workers=TARGET_WORKERS) as executor:
        results = executor.map(process_single_file, tasks)
        for res_list in results:
            all_summaries.extend(res_list)

    summary_df = pd.DataFrame(all_summaries)
    os.makedirs(cfg.output_dir, exist_ok=True)
    summary_path = os.path.join(cfg.output_dir, "summary_open_only.csv")
    
    if not summary_df.empty:
        # 重排字段，把总数和分方向数放在最直观的前排
        cols_order = [
            "symbol", "window_min", "z_open", "orders", 
            "orders_side_ab", "orders_side_ba", 
            "profit_usd_total", "final_position_usd", "avg_adj_spread_pct"
        ]
        remaining_cols = [c for c in summary_df.columns if c not in cols_order]
        summary_df = summary_df[cols_order + remaining_cols]
        
        summary_df.to_csv(summary_path, index=False)
        print(f"\n[DONE] c7i.2xlarge 8核全开并行计算完毕！合并结果已合并至: {summary_path}")
        print(f"最终生成参数表现报告总数: {len(summary_df)} 条")
    else:
        print("[DONE] 回测运行完毕，但未生成任何有效记录。")


if __name__ == "__main__":
    main()

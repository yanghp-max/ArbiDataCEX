import argparse
import glob
import os
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

# 固定滚动窗口（分钟）
# 需要调整时，直接改这个列表即可。
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


def parse_window_token_to_min(token: str) -> int:
    t = token.strip().lower()
    if not t:
        raise ValueError("empty window token")
    if t.endswith("m"):
        return int(t[:-1])
    if t.endswith("h"):
        return int(float(t[:-1]) * 60)
    return int(t)


def parse_args() -> BacktestConfig:
    parser = argparse.ArgumentParser(
        description="CEX-CEX open-only backtest (Binance=A, Gate=B)"
    )
    parser.add_argument("--data_dir", default="./data/meta_data")
    parser.add_argument("--output_dir", default="./data/output_open_only")
    parser.add_argument("--window_min", type=int, default=30)
    parser.add_argument("--min_periods", type=int, default=30)
    parser.add_argument("--z_open", type=float, default=2.0)
    parser.add_argument(
        "--z_open_list",
        default="",
        help="Comma separated z_open values, e.g. 1.2,1.5,2.0. If set, overrides --z_open."
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
        # 默认扫描 z_open = 0,1,2,3,4
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
        "spread_ab",
        "spread_ba",
        "cex_a_bid",
        "cex_a_ask",
        "cex_b_bid",
        "cex_b_ask",
        "binance_bid",
        "binance_ask",
        "gate_bid",
        "gate_ask",
        "binance_funding_rate",
        "gate_funding_rate",
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

    # A = Binance, B = Gate
    # spread_ab: -a+b => short A, long B
    # spread_ba: +a-b => long A, short B
    df["spread_ab"] = (df[a_bid_col] - df[b_ask_col]) / df[b_ask_col] * 100.0
    df["spread_ba"] = (df[b_bid_col] - df[a_ask_col]) / df[a_ask_col] * 100.0
    return df


def compute_signal_features(df: pd.DataFrame, cfg: BacktestConfig) -> pd.DataFrame:
    out = df.copy()

    total_cost_pct = (cfg.fee_bps_total + cfg.slippage_bps_total) / 100.0
    # Spread is in percent units, so subtract percent points directly.
    out["spread_ab_adj"] = out["spread_ab"] - total_cost_pct
    out["spread_ba_adj"] = out["spread_ba"] - total_cost_pct

    win = f"{cfg.window_min}min"
    out["dt"] = pd.to_datetime(out["timestamp"], unit="ms")
    out = out.set_index("dt")

    out["median_ab"] = out["spread_ab_adj"].rolling(win, min_periods=cfg.min_periods).median()
    out["median_ba"] = out["spread_ba_adj"].rolling(win, min_periods=cfg.min_periods).median()

    out["mad_ab"] = (
        (out["spread_ab_adj"] - out["median_ab"])
        .abs()
        .rolling(win, min_periods=cfg.min_periods)
        .median()
    )
    out["mad_ba"] = (
        (out["spread_ba_adj"] - out["median_ba"])
        .abs()
        .rolling(win, min_periods=cfg.min_periods)
        .median()
    )

    out["mad_ab"] = out["mad_ab"].replace(0, np.nan).fillna(1e-6)
    out["mad_ba"] = out["mad_ba"].replace(0, np.nan).fillna(1e-6)

    out["z_ab"] = (out["spread_ab_adj"] - out["median_ab"]) / out["mad_ab"]
    out["z_ba"] = (out["spread_ba_adj"] - out["median_ba"]) / out["mad_ba"]

    out["z_ab"] = out["z_ab"].replace([np.inf, -np.inf], np.nan).fillna(0.0)
    out["z_ba"] = out["z_ba"].replace([np.inf, -np.inf], np.nan).fillna(0.0)

    return out.reset_index(drop=False)


def simulate_open_only(df: pd.DataFrame, symbol: str, cfg: BacktestConfig) -> Tuple[pd.DataFrame, Dict]:
    funding_a_col = pick_col(df, ["binance_funding_rate"])
    funding_b_col = pick_col(df, ["gate_funding_rate"])

    pos_usd = 0.0
    last_order_ts = -10**18
    trade_id = 0

    blocked_by_funding = 0
    blocked_by_rate_limit = 0
    blocked_by_position = 0
    evaluated_points = 0

    orders = []

    for _, row in df.iterrows():
        ts = int(row["timestamp"])
        evaluated_points += 1

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

        # 仅按 z_open 判断开仓，不再要求 spread > 0
        can_open_ab = row["z_ab"] >= cfg.z_open
        can_open_ba = row["z_ba"] >= cfg.z_open
        if not can_open_ab and not can_open_ba:
            continue

        # -a+b: short Binance(A), long Gate(B)
        # +a-b: long Binance(A), short Gate(B)
        if can_open_ab and can_open_ba:
            direction = "-a+b" if row["z_ab"] >= row["z_ba"] else "+a-b"
        elif can_open_ab:
            direction = "-a+b"
        else:
            direction = "+a-b"

        adj_spread = row["spread_ab_adj"] if direction == "-a+b" else row["spread_ba_adj"]
        z_value = row["z_ab"] if direction == "-a+b" else row["z_ba"]
        expected_edge_usd = cfg.order_usd * adj_spread / 100.0

        trade_id += 1
        pos_usd += cfg.order_usd
        last_order_ts = ts
        orders.append(
            {
                "trade_id": trade_id,
                "symbol": symbol,
                "timestamp": ts,
                "datetime": pd.to_datetime(ts, unit="ms"),
                "direction": direction,
                "order_usd": cfg.order_usd,
                "position_after_usd": pos_usd,
                "spread_ab": row["spread_ab"],
                "spread_ba": row["spread_ba"],
                "spread_ab_adj": row["spread_ab_adj"],
                "spread_ba_adj": row["spread_ba_adj"],
                "z_ab": row["z_ab"],
                "z_ba": row["z_ba"],
                "chosen_z": z_value,
                "chosen_adj_spread_pct": adj_spread,
                "profit_usd": expected_edge_usd,
                "binance_funding_rate": funding_a,
                "gate_funding_rate": funding_b,
            }
        )

    orders_df = pd.DataFrame(orders)
    profit_total = float(orders_df["profit_usd"].sum()) if not orders_df.empty else 0.0
    summary = {
        "symbol": symbol,
        "rows": len(df),
        "orders": len(orders_df),
        "final_position_usd": pos_usd,
        "max_orders_capacity": int(cfg.max_position_usd // cfg.order_usd),
        "profit_usd_total": profit_total,
        "avg_adj_spread_pct": float(orders_df["chosen_adj_spread_pct"].mean()) if not orders_df.empty else 0.0,
        "blocked_by_funding": blocked_by_funding,
        "blocked_by_rate_limit": blocked_by_rate_limit,
        "blocked_by_position": blocked_by_position,
        "evaluated_points": evaluated_points,
    }
    return orders_df, summary


def run_one_file(path: str, cfg: BacktestConfig) -> Dict:
    symbol = os.path.splitext(os.path.basename(path))[0]
    raw = load_symbol_csv(path)
    raw = ensure_spreads(raw)
    features = compute_signal_features(raw, cfg)
    orders_df, summary = simulate_open_only(features, symbol, cfg)

    os.makedirs(cfg.output_dir, exist_ok=True)
    detail_out = os.path.join(cfg.output_dir, f"{symbol}_open_only_orders.csv")
    signal_out = os.path.join(cfg.output_dir, f"{symbol}_signals.csv")
    orders_df.to_csv(detail_out, index=False)
    features.to_csv(signal_out, index=False)
    summary["orders_file"] = detail_out
    summary["signals_file"] = signal_out
    return summary


def run_one_file_for_z(
    path: str,
    cfg: BacktestConfig,
    z_open_value: float,
    window_min_value: int,
) -> Dict:
    symbol = os.path.splitext(os.path.basename(path))[0]
    raw = load_symbol_csv(path)
    raw = ensure_spreads(raw)
    features = compute_signal_features(raw, cfg)

    cfg_for_z = BacktestConfig(
        data_dir=cfg.data_dir,
        output_dir=cfg.output_dir,
        window_min=window_min_value,
        min_periods=cfg.min_periods,
        z_open=z_open_value,
        order_usd=cfg.order_usd,
        max_position_usd=cfg.max_position_usd,
        cooldown_ms=cfg.cooldown_ms,
        funding_min=cfg.funding_min,
        fee_bps_total=cfg.fee_bps_total,
        slippage_bps_total=cfg.slippage_bps_total,
        symbols=cfg.symbols,
        z_open_list=cfg.z_open_list,
        window_min_list=cfg.window_min_list,
    )
    orders_df, summary = simulate_open_only(features, symbol, cfg_for_z)

    os.makedirs(cfg.output_dir, exist_ok=True)
    z_tag = str(z_open_value).replace(".", "_")
    w_tag = f"{window_min_value}m"
    detail_out = os.path.join(
        cfg.output_dir,
        f"{symbol}_w{w_tag}_z{z_tag}_open_only_orders.csv",
    )
    signal_out = os.path.join(
        cfg.output_dir,
        f"{symbol}_w{w_tag}_z{z_tag}_signals.csv",
    )
    orders_df.to_csv(detail_out, index=False)
    features.to_csv(signal_out, index=False)
    summary["z_open"] = z_open_value
    summary["window_min"] = window_min_value
    summary["orders_file"] = detail_out
    summary["signals_file"] = signal_out
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


def main():
    cfg = parse_args()
    files = pick_input_files(cfg)
    if not files:
        print(f"[ERROR] no csv files found in {cfg.data_dir} with symbols={cfg.symbols}")
        return

    all_summaries = []
    print(
        f"[START] files={len(files)} window_list={cfg.window_min_list} z_open_list={cfg.z_open_list} "
        f"order_usd={cfg.order_usd} max_pos={cfg.max_position_usd}"
    )

    for w_idx, window_min_value in enumerate(cfg.window_min_list, 1):
        print(
            f"\n[WINDOW-SCAN] ({w_idx}/{len(cfg.window_min_list)}) "
            f"window={window_min_value}min"
        )
        for z_idx, z_open_value in enumerate(cfg.z_open_list, 1):
            print(f"[Z-SCAN] ({z_idx}/{len(cfg.z_open_list)}) z_open={z_open_value}")
            z_summaries = []
            for i, f in enumerate(files, 1):
                try:
                    summary = run_one_file_for_z(
                        f,
                        cfg,
                        z_open_value=z_open_value,
                        window_min_value=window_min_value,
                    )
                    z_summaries.append(summary)
                    all_summaries.append(summary)
                    print(
                        f"[{i}/{len(files)}] {summary['symbol']}: orders={summary['orders']}, "
                        f"final_pos={summary['final_position_usd']:.2f}U, "
                        f"profit={summary['profit_usd_total']:.4f}U"
                    )
                except Exception as exc:
                    print(f"[{i}/{len(files)}] FAILED {f}: {exc}")

            if z_summaries:
                z_df = pd.DataFrame(z_summaries)
                z_total_orders = int(z_df["orders"].sum())
                z_total_profit = float(z_df["profit_usd_total"].sum())
                print(
                    f"[Z-SCAN] window={window_min_value}min z_open={z_open_value} "
                    f"total_orders={z_total_orders}, total_profit={z_total_profit:.4f}U"
                )

    summary_df = pd.DataFrame(all_summaries)
    os.makedirs(cfg.output_dir, exist_ok=True)
    summary_path = os.path.join(cfg.output_dir, "summary_open_only.csv")
    summary_df.to_csv(summary_path, index=False)

    if not summary_df.empty:
        compare_df = (
            summary_df.groupby(["window_min", "z_open"], as_index=False)
            .agg(
                symbols=("symbol", "count"),
                total_orders=("orders", "sum"),
                total_profit_usd=("profit_usd_total", "sum"),
                avg_profit_per_symbol=("profit_usd_total", "mean"),
                avg_orders_per_symbol=("orders", "mean"),
            )
            .sort_values(["window_min", "z_open"])
        )
        compare_path = os.path.join(cfg.output_dir, "z_open_comparison.csv")
        compare_df.to_csv(compare_path, index=False)
        print(f"[DONE] summary={summary_path}")
        print(f"[DONE] z comparison={compare_path}")
    else:
        print(f"[DONE] summary={summary_path} (empty)")


if __name__ == "__main__":
    main()

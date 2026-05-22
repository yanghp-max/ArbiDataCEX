import argparse
import glob
import os
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

# =========================
# 顶部默认参数（直接改这里）
# =========================
DEFAULT_DATA_DIR = "./data/meta_data"  # 回测输入数据目录（每个币种一个 CSV）
DEFAULT_OUTPUT_DIR = "./data/output_open_only_single"  # 回测输出目录（summary + trades）
DEFAULT_WINDOW_MIN = 60  # 滚动窗口分钟数（并且严格要求累计满该分钟数后才开始交易）
DEFAULT_Z_OPEN_AB = 4.0  # -a+b 方向开仓阈值（z_ab >= 该值触发）
DEFAULT_Z_OPEN_BA = 0.0  # +a-b 方向开仓阈值（z_ba >= 该值触发）
DEFAULT_ORDER_USD = 100.0  # 单次下单名义金额（USD）
DEFAULT_MAX_POSITION_USD = 2000.0  # 单腿最大持仓名义金额上限（USD）
DEFAULT_COOLDOWN_MS = 1000  # 下单冷却时间（毫秒）
DEFAULT_FUNDING_MIN = -0.1  # 资金费率下限，任一侧低于该值则禁止开仓
DEFAULT_FEE_BPS_TOTAL = 4.0  # 双边总手续费（bps）
DEFAULT_SLIPPAGE_BPS_TOTAL = 4.0  # 双边总滑点（bps）
DEFAULT_CLOSE_TWAP_MIN = 5  # 末尾 TWAP 强平取样窗口（分钟）
DEFAULT_SYMBOLS = "SKYAIUSDT"  # 逗号分隔币种；空字符串表示全量


@dataclass
class SingleRunConfig:
    data_dir: str
    output_dir: str
    window_min: int
    z_open_ab: float
    z_open_ba: float
    order_usd: float
    max_position_usd: float
    cooldown_ms: int
    funding_min: float
    fee_bps_total: float
    slippage_bps_total: float
    close_twap_min: int
    symbols: Optional[List[str]]


def parse_args() -> SingleRunConfig:
    parser = argparse.ArgumentParser(
        description="CEX-CEX open-only backtest (single window + single z_ab/z_ba) with full trade logs."
    )
    parser.add_argument("--data_dir", default=DEFAULT_DATA_DIR)
    parser.add_argument("--output_dir", default=DEFAULT_OUTPUT_DIR)
    parser.add_argument("--window_min", type=int, default=DEFAULT_WINDOW_MIN)
    parser.add_argument("--z_open_ab", type=float, default=DEFAULT_Z_OPEN_AB, help="-a+b direction threshold")
    parser.add_argument("--z_open_ba", type=float, default=DEFAULT_Z_OPEN_BA, help="+a-b direction threshold")
    parser.add_argument("--order_usd", type=float, default=DEFAULT_ORDER_USD)
    parser.add_argument("--max_position_usd", type=float, default=DEFAULT_MAX_POSITION_USD)
    parser.add_argument("--cooldown_ms", type=int, default=DEFAULT_COOLDOWN_MS)
    parser.add_argument("--funding_min", type=float, default=DEFAULT_FUNDING_MIN)
    parser.add_argument("--fee_bps_total", type=float, default=DEFAULT_FEE_BPS_TOTAL)
    parser.add_argument("--slippage_bps_total", type=float, default=DEFAULT_SLIPPAGE_BPS_TOTAL)
    parser.add_argument("--close_twap_min", type=int, default=DEFAULT_CLOSE_TWAP_MIN)
    parser.add_argument(
        "--symbols",
        default=DEFAULT_SYMBOLS,
        help="Comma separated symbols, e.g. BTCUSDT,ETHUSDT. Empty means all csv files.",
    )
    args = parser.parse_args()

    symbols = [s.strip() for s in args.symbols.split(",") if s.strip()] or None
    return SingleRunConfig(
        data_dir=args.data_dir,
        output_dir=args.output_dir,
        window_min=args.window_min,
        z_open_ab=args.z_open_ab,
        z_open_ba=args.z_open_ba,
        order_usd=args.order_usd,
        max_position_usd=args.max_position_usd,
        cooldown_ms=args.cooldown_ms,
        funding_min=args.funding_min,
        fee_bps_total=args.fee_bps_total,
        slippage_bps_total=args.slippage_bps_total,
        close_twap_min=args.close_twap_min,
        symbols=symbols,
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


def compute_signal_features(df: pd.DataFrame, cfg: SingleRunConfig) -> pd.DataFrame:
    out = df.copy()

    total_cost_pct = (cfg.fee_bps_total + cfg.slippage_bps_total) / 100.0
    out["spread_ab_adj"] = out["spread_ab"] - total_cost_pct
    out["spread_ba_adj"] = out["spread_ba"] - total_cost_pct

    win = f"{cfg.window_min}min"
    out["dt"] = pd.to_datetime(out["timestamp"], unit="ms")
    out = out.set_index("dt")

    # 统计窗口使用原始价差
    out["median_ab"] = out["spread_ab"].rolling(win, min_periods=1).median()
    out["median_ba"] = out["spread_ba"].rolling(win, min_periods=1).median()

    out["mad_ab"] = (
        (out["spread_ab"] - out["median_ab"]).abs().rolling(win, min_periods=1).median()
    )
    out["mad_ba"] = (
        (out["spread_ba"] - out["median_ba"]).abs().rolling(win, min_periods=1).median()
    )
    out["mad_ab"] = out["mad_ab"].replace(0, np.nan)
    out["mad_ba"] = out["mad_ba"].replace(0, np.nan)

    # zscore 当前值使用扣成本后的价差
    out["z_ab"] = (out["spread_ab_adj"] - out["median_ab"]) / out["mad_ab"]
    out["z_ba"] = (out["spread_ba_adj"] - out["median_ba"]) / out["mad_ba"]
    return out.reset_index(drop=False)


def simulate_single_combo(df: pd.DataFrame, symbol: str, cfg: SingleRunConfig) -> Tuple[Dict, List[Dict]]:
    funding_a_col = pick_col(df, ["binance_funding_rate"])
    funding_b_col = pick_col(df, ["gate_funding_rate"])
    a_bid_col, a_ask_col, b_bid_col, b_ask_col = resolve_price_cols(df)

    a_pos_qty = 0.0
    b_pos_qty = 0.0
    max_seen_position_qty = 0.0
    first_open_ts: Optional[int] = None

    last_order_ts = -10**18
    trade_id = 0
    orders_side_ab = 0
    orders_side_ba = 0
    blocked_by_funding = 0
    blocked_by_rate_limit = 0
    blocked_by_position = 0
    clipped_by_position = 0
    blocked_by_spread_filter = 0
    evaluated_points = 0

    open_profit_total = 0.0
    cumulative_pnl = 0.0
    fee_rate_total = (cfg.fee_bps_total + cfg.slippage_bps_total) / 10000.0
    fee_rate_per_leg = fee_rate_total / 2.0
    total_adj_spread_pct = 0.0
    trade_rows: List[Dict] = []

    def normalize_qty(qty: float) -> float:
        return float(np.round(qty, 12))

    def interval_for_leg(pos: float, delta_sign: int, limit: float) -> Tuple[float, float]:
        if delta_sign == 1:
            return -limit - pos, limit - pos
        return pos - limit, pos + limit

    def max_feasible_qty(pos_a: float, pos_b: float, limit: float, delta_a: int, delta_b: int) -> float:
        low_a, high_a = interval_for_leg(pos_a, delta_a, limit)
        low_b, high_b = interval_for_leg(pos_b, delta_b, limit)
        low = max(0.0, low_a, low_b)
        high = min(high_a, high_b)
        if high < low:
            return 0.0
        return max(0.0, high)

    def calc_close_profit(close_qty: float, a_px_close: float, b_px_close: float, side: str) -> Tuple[float, float, float]:
        if close_qty <= 1e-12 or not np.isfinite(a_px_close) or not np.isfinite(b_px_close) or a_px_close <= 0 or b_px_close <= 0:
            return 0.0, 0.0, 0.0
        if side == "-a+b":
            gross_close = close_qty * b_px_close - close_qty * a_px_close
        else:
            gross_close = close_qty * a_px_close - close_qty * b_px_close
        fee_close = abs(close_qty * a_px_close) * fee_rate_per_leg + abs(close_qty * b_px_close) * fee_rate_per_leg
        return gross_close, fee_close, gross_close - fee_close

    if len(df) > 0:
        first_ts = int(df.iloc[0]["timestamp"])
    else:
        first_ts = 0
    warmup_end_ts = first_ts + int(cfg.window_min) * 60 * 1000

    for _, row in df.iterrows():
        ts = int(row["timestamp"])
        evaluated_points += 1

        # 严格要求累计满 window_min 分钟后才允许进入交易判断
        if ts < warmup_end_ts:
            continue

        if pd.isna(row["z_ab"]) or pd.isna(row["z_ba"]):
            continue
        if ts - last_order_ts < cfg.cooldown_ms:
            blocked_by_rate_limit += 1
            continue

        funding_a = row[funding_a_col] if funding_a_col else np.nan
        funding_b = row[funding_b_col] if funding_b_col else np.nan
        if pd.isna(funding_a) or pd.isna(funding_b) or funding_a < cfg.funding_min or funding_b < cfg.funding_min:
            blocked_by_funding += 1
            continue

        can_open_ab = row["z_ab"] >= cfg.z_open_ab
        can_open_ba = row["z_ba"] >= cfg.z_open_ba
        if not can_open_ab and not can_open_ba:
            continue

        if can_open_ab and can_open_ba:
            direction = "-a+b" if row["z_ab"] >= row["z_ba"] else "+a-b"
        elif can_open_ab:
            direction = "-a+b"
        else:
            direction = "+a-b"

        adj_spread = row["spread_ab_adj"] if direction == "-a+b" else row["spread_ba_adj"]
        if not (0.0 <= adj_spread <= 10.0):
            blocked_by_spread_filter += 1
            continue

        if direction == "-a+b":
            a_px = float(row[a_bid_col])
            b_px = float(row[b_ask_col])
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
            a_pos_qty -= qty
            b_pos_qty += qty
            orders_side_ab += 1
        else:
            a_px = float(row[a_ask_col])
            b_px = float(row[b_bid_col])
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
            a_pos_qty += qty
            b_pos_qty -= qty
            orders_side_ba += 1

        if first_open_ts is None:
            first_open_ts = ts
        trade_id += 1
        last_order_ts = ts
        open_profit_total += trade_profit
        cumulative_pnl += trade_profit
        total_adj_spread_pct += adj_spread
        max_seen_position_qty = max(max_seen_position_qty, abs(a_pos_qty), abs(b_pos_qty))

        trade_rows.append(
            {
                "symbol": symbol,
                "trade_index": trade_id,
                "action": "OPEN",
                "direction": direction,
                "timestamp": ts,
                "datetime": pd.to_datetime(ts, unit="ms"),
                "a_price_used": a_px,
                "b_price_used": b_px,
                "qty": qty,
                "a_pos_qty": a_pos_qty,
                "b_pos_qty": b_pos_qty,
                "gross_pnl": gross_profit,
                "fee_cost": fee_cost,
                "net_pnl": trade_profit,
                "cum_pnl": cumulative_pnl,
                "z_ab": row["z_ab"],
                "z_ba": row["z_ba"],
                "spread_ab": row["spread_ab"],
                "spread_ba": row["spread_ba"],
                "spread_ab_adj": row["spread_ab_adj"],
                "spread_ba_adj": row["spread_ba_adj"],
            }
        )

    close_profit_twap = 0.0
    close_profit_avg_since_open = 0.0
    if len(df) > 0 and (abs(a_pos_qty) > 1e-12 or abs(b_pos_qty) > 1e-12):
        close_qty = min(abs(a_pos_qty), abs(b_pos_qty))
        if close_qty > 1e-12:
            last = df.iloc[-1]
            end_ts = int(last["timestamp"])
            twap_start_ts = end_ts - int(cfg.close_twap_min) * 60 * 1000
            twap_df = df[df["timestamp"] >= twap_start_ts]
            if len(twap_df) == 0:
                twap_df = df.tail(1)
            since_open_df = df[df["timestamp"] >= first_open_ts] if first_open_ts is not None else df.tail(1)
            if len(since_open_df) == 0:
                since_open_df = df.tail(1)

            if a_pos_qty < 0:
                side = "-a+b"
                a_series_twap = pd.to_numeric(twap_df[a_ask_col], errors="coerce")
                b_series_twap = pd.to_numeric(twap_df[b_bid_col], errors="coerce")
                a_series_avg = pd.to_numeric(since_open_df[a_ask_col], errors="coerce")
                b_series_avg = pd.to_numeric(since_open_df[b_bid_col], errors="coerce")
            else:
                side = "+a-b"
                a_series_twap = pd.to_numeric(twap_df[a_bid_col], errors="coerce")
                b_series_twap = pd.to_numeric(twap_df[b_ask_col], errors="coerce")
                a_series_avg = pd.to_numeric(since_open_df[a_bid_col], errors="coerce")
                b_series_avg = pd.to_numeric(since_open_df[b_ask_col], errors="coerce")

            a_series_twap = a_series_twap[np.isfinite(a_series_twap) & (a_series_twap > 0)]
            b_series_twap = b_series_twap[np.isfinite(b_series_twap) & (b_series_twap > 0)]
            a_series_avg = a_series_avg[np.isfinite(a_series_avg) & (a_series_avg > 0)]
            b_series_avg = b_series_avg[np.isfinite(b_series_avg) & (b_series_avg > 0)]

            if len(a_series_twap) > 0 and len(b_series_twap) > 0:
                a_close_px_twap = float(a_series_twap.mean())
                b_close_px_twap = float(b_series_twap.mean())
                gross_twap, fee_twap, close_profit_twap = calc_close_profit(
                    close_qty, a_close_px_twap, b_close_px_twap, side
                )
                trade_id += 1
                trade_rows.append(
                    {
                        "symbol": symbol,
                        "trade_index": trade_id,
                        "action": "FORCE_CLOSE",
                        "direction": side,
                        "timestamp": end_ts,
                        "datetime": pd.to_datetime(end_ts, unit="ms"),
                        "a_price_used": a_close_px_twap,
                        "b_price_used": b_close_px_twap,
                        "qty": close_qty,
                        "a_pos_qty": 0.0,
                        "b_pos_qty": 0.0,
                        "gross_pnl": gross_twap,
                        "fee_cost": fee_twap,
                        "net_pnl": close_profit_twap,
                        "cum_pnl": open_profit_total + close_profit_twap,
                        "z_ab": np.nan,
                        "z_ba": np.nan,
                        "spread_ab": np.nan,
                        "spread_ba": np.nan,
                        "spread_ab_adj": np.nan,
                        "spread_ba_adj": np.nan,
                        "close_mode": "twap",
                    }
                )

            if len(a_series_avg) > 0 and len(b_series_avg) > 0:
                a_close_px_avg = float(a_series_avg.mean())
                b_close_px_avg = float(b_series_avg.mean())
                gross_avg, fee_avg, close_profit_avg_since_open = calc_close_profit(
                    close_qty, a_close_px_avg, b_close_px_avg, side
                )
                trade_id += 1
                trade_rows.append(
                    {
                        "symbol": symbol,
                        "trade_index": trade_id,
                        "action": "FORCE_CLOSE",
                        "direction": side,
                        "timestamp": end_ts,
                        "datetime": pd.to_datetime(end_ts, unit="ms"),
                        "a_price_used": a_close_px_avg,
                        "b_price_used": b_close_px_avg,
                        "qty": close_qty,
                        "a_pos_qty": 0.0,
                        "b_pos_qty": 0.0,
                        "gross_pnl": gross_avg,
                        "fee_cost": fee_avg,
                        "net_pnl": close_profit_avg_since_open,
                        "cum_pnl": open_profit_total + close_profit_avg_since_open,
                        "z_ab": np.nan,
                        "z_ba": np.nan,
                        "spread_ab": np.nan,
                        "spread_ba": np.nan,
                        "spread_ab_adj": np.nan,
                        "spread_ba_adj": np.nan,
                        "close_mode": "avg_since_open",
                    }
                )

            a_pos_qty = 0.0
            b_pos_qty = 0.0

    profit_total_twap = open_profit_total + close_profit_twap
    profit_total_avg_since_open = open_profit_total + close_profit_avg_since_open
    summary = {
        "symbol": symbol,
        "window_min": cfg.window_min,
        "z_open_ab": cfg.z_open_ab,
        "z_open_ba": cfg.z_open_ba,
        "rows": len(df),
        "orders": trade_id,
        "orders_side_ab": orders_side_ab,
        "orders_side_ba": orders_side_ba,
        "open_profit_usd_total": open_profit_total,
        "close_profit_usd_total": close_profit_twap,
        "profit_usd_total": profit_total_twap,
        "close_profit_twap": close_profit_twap,
        "close_profit_avg_since_open": close_profit_avg_since_open,
        "profit_usd_total_twap": profit_total_twap,
        "profit_usd_total_avg_since_open": profit_total_avg_since_open,
        "max_seen_position_qty": max_seen_position_qty,
        "final_a_position_qty": a_pos_qty,
        "final_b_position_qty": b_pos_qty,
        "avg_adj_spread_pct": float(total_adj_spread_pct / max(orders_side_ab + orders_side_ba, 1)),
        "blocked_by_funding": blocked_by_funding,
        "blocked_by_rate_limit": blocked_by_rate_limit,
        "blocked_by_position": blocked_by_position,
        "clipped_by_position": clipped_by_position,
        "blocked_by_spread_filter": blocked_by_spread_filter,
        "evaluated_points": evaluated_points,
    }
    return summary, trade_rows


def pick_input_files(cfg: SingleRunConfig) -> List[str]:
    files = sorted(glob.glob(os.path.join(cfg.data_dir, "*.csv")))
    if not cfg.symbols:
        return files
    symbol_set = set(cfg.symbols)
    return [f for f in files if os.path.splitext(os.path.basename(f))[0] in symbol_set]


def main() -> None:
    cfg = parse_args()
    files = pick_input_files(cfg)
    if not files:
        print(f"[ERROR] no csv files found in {cfg.data_dir} with symbols={cfg.symbols}")
        return

    os.makedirs(cfg.output_dir, exist_ok=True)
    summary_rows: List[Dict] = []
    all_trade_rows: List[Dict] = []

    print(
        f"[START] Single-combo backtest: window={cfg.window_min}, "
        f"z_ab={cfg.z_open_ab}, z_ba={cfg.z_open_ba}, close_modes=twap+avg_since_open"
    )
    for i, path in enumerate(files, 1):
        symbol = os.path.splitext(os.path.basename(path))[0]
        print(f"[{i}/{len(files)}] processing {symbol}")
        try:
            raw_data = ensure_spreads(load_symbol_csv(path))
            features = compute_signal_features(raw_data, cfg)
            summary, trade_rows = simulate_single_combo(features, symbol, cfg)
            summary_rows.append(summary)
            all_trade_rows.extend(trade_rows)
        except Exception as exc:
            print(f"[ERROR] {symbol}: {exc}")

    summary_path = os.path.join(cfg.output_dir, "summary_single_combo.csv")
    trades_path = os.path.join(cfg.output_dir, "trades_single_combo.csv")
    pd.DataFrame(summary_rows).to_csv(summary_path, index=False)
    pd.DataFrame(all_trade_rows).to_csv(trades_path, index=False)

    print(f"[DONE] summary -> {summary_path}")
    print(f"[DONE] trades  -> {trades_path}")


if __name__ == "__main__":
    main()

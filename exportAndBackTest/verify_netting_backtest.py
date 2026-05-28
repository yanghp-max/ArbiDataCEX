"""Quick verification that netting backtest counts orders and close logic correctly."""

import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))
from backtest_cex_cex_open_only import BacktestConfig, compute_signal_features, simulate_open_only


def make_synthetic_symbol(n_ticks: int = 8000) -> pd.DataFrame:
    ts0 = 1_700_000_000_000
    rng = np.random.default_rng(42)
    rows = []
    for i in range(n_ticks):
        ts = ts0 + i * 1000
        base_ab = 0.12 + 0.03 * np.sin(i / 17.0) + rng.normal(0, 0.01)
        base_ba = 0.10 + 0.025 * np.sin(i / 19.0) + rng.normal(0, 0.01)
        spike_ab = 0.8 if i % 37 == 0 else 0.0
        spike_ba = 0.7 if i % 41 == 0 else 0.0
        rows.append(
            {
                "timestamp": ts,
                "spread_ab": max(base_ab + spike_ab, 0.09),
                "spread_ba": max(base_ba + spike_ba, 0.09),
                "binance_bid": 100.0,
                "binance_ask": 100.1,
                "gate_bid": 99.9,
                "gate_ask": 100.0,
                "binance_funding_rate": 0.01,
                "gate_funding_rate": 0.01,
            }
        )
    return pd.DataFrame(rows)


def run_checks() -> None:
    cfg = BacktestConfig(
        data_dir=".",
        output_dir=".",
        window_min=10,
        z_open=0.0,
        z_close=0.0,
        order_usd=100.0,
        max_position_usd=2000.0,
        cooldown_ms=1000,
        funding_min=-0.1,
        fee_bps_total=4.0,
        slippage_bps_total=4.0,
        symbols=None,
        z_open_list=[0.0, 1.0],
        z_close_list=[0.0, 1.0],
        window_min_list=[10, 30],
    )

    raw = make_synthetic_symbol()
    failures = []
    checked = 0

    for window in cfg.window_min_list:
        features = compute_signal_features(raw, cfg, window)
        for z_open in cfg.z_open_list:
            for z_close in cfg.z_close_list:
                summary = simulate_open_only(
                    features,
                    "SYNTH",
                    cfg,
                    window,
                    z_open,
                    z_close,
                )
                checked += 1
                if summary["orders"] != summary["open_orders"] + summary["close_orders"]:
                    failures.append(
                        f"w={window} z_open={z_open} z_close={z_close}: "
                        f"orders={summary['orders']} != open_orders({summary['open_orders']}) + "
                        f"close_orders({summary['close_orders']})"
                    )
                if summary["final_a_position_qty"] != 0.0 or summary["final_b_position_qty"] != 0.0:
                    failures.append(
                        f"w={window} z_open={z_open} z_close={z_close}: "
                        f"final position not flat: a={summary['final_a_position_qty']}, b={summary['final_b_position_qty']}"
                    )

    print(f"Checked {checked} parameter combos on synthetic data.")
    if failures:
        print("FAILED:")
        for msg in failures:
            print(f"  - {msg}")
        raise SystemExit(1)

    sample = simulate_open_only(
        compute_signal_features(raw, cfg, 10),
        "SYNTH",
        cfg,
        10,
        0.0,
        0.0,
    )
    print("Sample combo (window=10, z_open=0, z_close=0):")
    print(f"  orders={sample['orders']}")
    print(f"  open_orders={sample['open_orders']}")
    print(f"  close_orders={sample['close_orders']}")
    print(f"  open_profit={sample['open_profit_usd_total']:.4f}")
    print(f"  close_profit_in_sim={sample['close_profit_in_sim']:.4f}")
    print(f"  profit_total={sample['profit_usd_total']:.4f}")
    if sample["orders"] <= 0:
        raise SystemExit("Sample combo produced zero orders; synthetic fixture too weak.")
    print("All checks passed.")


if __name__ == "__main__":
    run_checks()

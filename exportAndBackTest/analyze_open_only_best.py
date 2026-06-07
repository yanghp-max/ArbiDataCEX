#!/usr/bin/env python3
"""Analyze summary_open_only CSV and find best param combo per symbol."""
import sys
import pandas as pd

path = sys.argv[1] if len(sys.argv) > 1 else r"d:\chatRecord\weiChatRecord\xwechat_files\yanghongpeng736410_0728\msg\file\2026-05\summary_open_only方向.csv"
df = pd.read_csv(path)

PRIMARY = "profit_usd_total"  # last_tick forced flat (= profit_usd_total_last_tick)
SECONDARY = ["open_profit_usd_total", "profit_usd_total", "orders", "avg_adj_spread_pct"]

idx = df.groupby("symbol")[PRIMARY].idxmax()
best = df.loc[idx].sort_values("symbol").copy()

print(f"Data: {len(df)} rows, {df['symbol'].nunique()} symbols, {len(df)//df['symbol'].nunique()} combos/symbol")
print(f"Optimization metric: {PRIMARY} (last_tick forced flat at end)")
print(f"Positive symbols: {(best[PRIMARY] > 0).sum()}/{len(best)}")
print()

cols = ["symbol", "window_min", "z_open_ab", "z_open_ba", PRIMARY] + SECONDARY
cols = [c for c in cols if c in best.columns]

print("=" * 120)
print(f"{'symbol':<18} {'window':>6} {'z_ab':>4} {'z_ba':>4} {'profit_lt':>12} {'open_pnl':>10} {'close_lt':>10} {'orders':>6} {'spread%':>8}")
print("=" * 120)

for _, r in best.iterrows():
    print(
        f"{r['symbol']:<18} {int(r['window_min']):>6} {r['z_open_ab']:>4.0f} {r['z_open_ba']:>4.0f} "
        f"{r[PRIMARY]:>12.2f} {r['open_profit_usd_total']:>10.2f} {r['close_profit_usd_total']:>10.2f} "
        f"{int(r['orders']):>6} {r['avg_adj_spread_pct']:>8.3f}"
    )

print()
print("=" * 80)
print("Summary statistics of best combos:")
print(f"  window_min distribution: {best['window_min'].value_counts().sort_index().to_dict()}")
print(f"  z_open_ab distribution:  {best['z_open_ab'].value_counts().sort_index().to_dict()}")
print(f"  z_open_ba distribution:  {best['z_open_ba'].value_counts().sort_index().to_dict()}")
print(f"  profit_last_tick: min={best[PRIMARY].min():.2f}, max={best[PRIMARY].max():.2f}, mean={best[PRIMARY].mean():.2f}, median={best[PRIMARY].median():.2f}")

# Also show top by open_profit only for comparison
print()
print("=" * 80)
print("Note: if optimizing by open_profit_usd_total instead, top 10 symbols differ:")
idx2 = df.groupby("symbol")["open_profit_usd_total"].idxmax()
best_open = df.loc[idx2].sort_values("open_profit_usd_total", ascending=False)
for _, r in best_open.head(10).iterrows():
    print(f"  {r['symbol']:<18} w={int(r['window_min']):4d} z_ab={r['z_open_ab']:.0f} z_ba={r['z_open_ba']:.0f}  open={r['open_profit_usd_total']:.2f}  last_tick={r[PRIMARY]:.2f}")

# Export CSV
out = path.replace(".csv", "_best_last_tick.csv")
best[cols].to_csv(out, index=False)
print(f"\nExported: {out}")

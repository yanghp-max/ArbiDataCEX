#!/usr/bin/env python3
"""Pick one global (window, z_ab, z_ba) combo from open_only backtest using last_tick PnL."""
import sys
import pandas as pd
import numpy as np

path = sys.argv[1]
df = pd.read_csv(path)
METRIC = "profit_usd_total"

g = df.groupby(["window_min", "z_open_ab", "z_open_ba"]).agg(
    total_profit=(METRIC, "sum"),
    avg_profit=(METRIC, "mean"),
    median_profit=(METRIC, "median"),
    positive_count=(METRIC, lambda s: (s > 0).sum()),
    zero_order_symbols=("orders", lambda s: (s == 0).sum()),
    total_orders=("orders", "sum"),
    total_open_profit=("open_profit_usd_total", "sum"),
    total_close_profit=("close_profit_usd_total", "sum"),
    min_symbol_profit=(METRIC, "min"),
    p25_profit=(METRIC, lambda s: s.quantile(0.25)),
).reset_index()

g["positive_rate"] = g["positive_count"] / 51
g["score_balanced"] = (
    g["total_profit"] * 0.35
    + g["avg_profit"] * 51 * 0.25
    + g["positive_count"] * 80
    + g["median_profit"] * 30
    + g["p25_profit"] * 20
    - g["zero_order_symbols"] * 200
    - np.minimum(g["min_symbol_profit"], 0) * 0.5
)

print("=== TOP 15 by total_profit (last_tick) ===")
top = g.sort_values("total_profit", ascending=False).head(15)
cols = ["window_min", "z_open_ab", "z_open_ba", "total_profit", "avg_profit", "positive_count", "zero_order_symbols", "total_orders", "min_symbol_profit"]
print(top[cols].to_string(index=False, float_format=lambda x: f"{x:.2f}"))

print("\n=== TOP 15 by balanced score ===")
top2 = g.sort_values("score_balanced", ascending=False).head(15)
print(top2[cols + ["score_balanced"]].to_string(index=False, float_format=lambda x: f"{x:.2f}"))

print("\n=== TOP 15 by positive_count (tie-break total_profit) ===")
top3 = g.sort_values(["positive_count", "total_profit"], ascending=[False, False]).head(15)
print(top3[cols].to_string(index=False, float_format=lambda x: f"{x:.2f}"))

# Per-window best
print("\n=== Best combo per window (by total_profit) ===")
for w in sorted(g["window_min"].unique()):
    sub = g[g["window_min"] == w].sort_values("total_profit", ascending=False).iloc[0]
    print(
        f"  w={int(sub['window_min']):3d} best z={sub['z_open_ab']:.0f}/{sub['z_open_ba']:.0f} "
        f"total={sub['total_profit']:.1f} avg={sub['avg_profit']:.1f} pos={int(sub['positive_count'])}/51 "
        f"zero={int(sub['zero_order_symbols'])} min={sub['min_symbol_profit']:.1f}"
    )

# Recommended pick detail
pick = g.sort_values("score_balanced", ascending=False).iloc[0]
w, za, zb = int(pick["window_min"]), pick["z_open_ab"], pick["z_open_ba"]
sub = df[(df["window_min"] == w) & (df["z_open_ab"] == za) & (df["z_open_ba"] == zb)].sort_values(METRIC, ascending=False)
neg = sub[sub[METRIC] <= 0]
print(f"\n=== RECOMMENDED: window={w}, z_open_ab={za:.0f}, z_open_ba={zb:.0f} ===")
print(f"total_profit={pick['total_profit']:.2f}, avg={pick['avg_profit']:.2f}, positive={int(pick['positive_count'])}/51")
print(f"zero-order symbols={int(pick['zero_order_symbols'])}, worst symbol={pick['min_symbol_profit']:.2f}")
print(f"top5 symbols:")
for _, r in sub.head(5).iterrows():
    print(f"  {r['symbol']}: {r[METRIC]:.2f} (open={r['open_profit_usd_total']:.2f}, close={r['close_profit_usd_total']:.2f}, orders={int(r['orders'])})")
print(f"negative/zero ({len(neg)}):")
for _, r in neg.sort_values(METRIC).iterrows():
    print(f"  {r['symbol']}: {r[METRIC]:.2f} orders={int(r['orders'])}")

print("\n=== Candidate head-to-head ===")
cands = [(720, 4, 0), (720, 3, 0), (360, 4, 0), (180, 4, 0)]
for w, za, zb in cands:
    s = df[(df["window_min"] == w) & (df["z_open_ab"] == za) & (df["z_open_ba"] == zb)]
    top10 = s.nlargest(10, METRIC)[METRIC].sum()
    print(
        f"  {w}/{za}/{zb}: total={s[METRIC].sum():.1f} median={s[METRIC].median():.1f} "
        f"pos={(s[METRIC] > 0).sum()} zero={(s.orders == 0).sum()} top10_share={100*top10/s[METRIC].sum():.0f}%"
    )

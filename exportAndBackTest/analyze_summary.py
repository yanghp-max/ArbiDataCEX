import pandas as pd

path = r"c:\Users\yanghongpeng\Desktop\summary_open_only.csv"
df = pd.read_csv(path)

group_cols = ["window_min", "z_open_ab", "z_open_ba"]
agg = df.groupby(group_cols).agg(
    symbols=("symbol", "count"),
    total_open_profit=("open_profit_usd_total", "sum"),
    total_profit=("profit_usd_total", "sum"),
    total_profit_rollback=("profit_usd_total_rollback_unopened_fifo", "sum"),
    avg_open_profit=("open_profit_usd_total", "mean"),
    avg_profit=("profit_usd_total", "mean"),
    avg_profit_rollback=("profit_usd_total_rollback_unopened_fifo", "mean"),
    total_orders=("orders", "sum"),
    symbols_profitable_total=("profit_usd_total", lambda x: (x > 0).sum()),
    symbols_profitable_open=("open_profit_usd_total", lambda x: (x > 0).sum()),
    symbols_profitable_rollback=(
        "profit_usd_total_rollback_unopened_fifo",
        lambda x: (x > 0).sum(),
    ),
    median_profit=("profit_usd_total", "median"),
    median_profit_rollback=("profit_usd_total_rollback_unopened_fifo", "median"),
).reset_index()


def print_top(title, data, sort_col, fmt_fn):
    print("=" * 80)
    print(title)
    print("=" * 80)
    for _, r in data.sort_values(sort_col, ascending=False).head(15).iterrows():
        print(fmt_fn(r))
    print()


print_top(
    "TOP 15 by total profit_usd_total (sum across 24 symbols)",
    agg,
    "total_profit",
    lambda r: (
        f"window={int(r.window_min):>3} z_ab={r.z_open_ab:.0f} z_ba={r.z_open_ba:.0f} | "
        f"total=${r.total_profit:>8.2f} avg=${r.avg_profit:>7.2f} med=${r.median_profit:>7.2f} | "
        f"open=${r.total_open_profit:>8.2f} rollback=${r.total_profit_rollback:>8.2f} | "
        f"profitable {int(r.symbols_profitable_total)}/24 orders={int(r.total_orders)}"
    ),
)

print_top(
    "TOP 15 by total profit_usd_total_rollback_unopened_fifo",
    agg,
    "total_profit_rollback",
    lambda r: (
        f"window={int(r.window_min):>3} z_ab={r.z_open_ab:.0f} z_ba={r.z_open_ba:.0f} | "
        f"rollback=${r.total_profit_rollback:>8.2f} avg=${r.avg_profit_rollback:>7.2f} "
        f"med=${r.median_profit_rollback:>7.2f} | "
        f"total=${r.total_profit:>8.2f} open=${r.total_open_profit:>8.2f} | "
        f"profitable {int(r.symbols_profitable_rollback)}/24"
    ),
)

print_top(
    "TOP 15 by total open_profit_usd_total",
    agg,
    "total_open_profit",
    lambda r: (
        f"window={int(r.window_min):>3} z_ab={r.z_open_ab:.0f} z_ba={r.z_open_ba:.0f} | "
        f"open=${r.total_open_profit:>8.2f} avg=${r.avg_open_profit:>7.2f} | "
        f"total=${r.total_profit:>8.2f} rollback=${r.total_profit_rollback:>8.2f} | "
        f"open_profitable {int(r.symbols_profitable_open)}/24"
    ),
)

print("=" * 80)
print("ROBUST: TOP 10 avg profit with >=18/24 symbols profitable (total profit)")
print("=" * 80)
robust = agg[agg["symbols_profitable_total"] >= 18].sort_values("avg_profit", ascending=False).head(10)
if len(robust) == 0:
    print("No combo with >=18 symbols profitable on total profit")
else:
    for _, r in robust.iterrows():
        print(
            f"window={int(r.window_min):>3} z_ab={r.z_open_ab:.0f} z_ba={r.z_open_ba:.0f} | "
            f"avg=${r.avg_profit:>7.2f} total=${r.total_profit:>8.2f} | "
            f"profitable {int(r.symbols_profitable_total)}/24"
        )
print()

print("=" * 80)
print("ROBUST rollback: TOP 10 avg rollback with >=20/24 symbols profitable")
print("=" * 80)
robust = agg[agg["symbols_profitable_rollback"] >= 20].sort_values(
    "avg_profit_rollback", ascending=False
).head(10)
for _, r in robust.iterrows():
    print(
        f"window={int(r.window_min):>3} z_ab={r.z_open_ab:.0f} z_ba={r.z_open_ba:.0f} | "
        f"avg_rollback=${r.avg_profit_rollback:>7.2f} total_rollback=${r.total_profit_rollback:>8.2f} | "
        f"profitable {int(r.symbols_profitable_rollback)}/24 total_profit=${r.total_profit:>8.2f}"
    )
print()

best_total = agg.loc[agg["total_profit"].idxmax()]
best_rollback = agg.loc[agg["total_profit_rollback"].idxmax()]

print("=" * 80)
print("SUMMARY RECOMMENDATIONS")
print("=" * 80)
print(
    f"Best total profit: window={int(best_total.window_min)} z_ab={best_total.z_open_ab:.0f} "
    f"z_ba={best_total.z_open_ba:.0f} -> ${best_total.total_profit:.2f} "
    f"({int(best_total.symbols_profitable_total)}/24 profitable)"
)
print(
    f"Best rollback fifo: window={int(best_rollback.window_min)} z_ab={best_rollback.z_open_ab:.0f} "
    f"z_ba={best_rollback.z_open_ba:.0f} -> ${best_rollback.total_profit_rollback:.2f} "
    f"({int(best_rollback.symbols_profitable_rollback)}/24 profitable)"
)
print()

print("=" * 80)
print("BEST z_ab/z_ba PER window_min (by total profit)")
print("=" * 80)
for w in sorted(df["window_min"].unique()):
    sub = agg[agg["window_min"] == w].sort_values("total_profit", ascending=False).iloc[0]
    print(
        f"window={int(w):>3}: z_ab={sub.z_open_ab:.0f} z_ba={sub.z_open_ba:.0f} "
        f"total=${sub.total_profit:.2f} rollback=${sub.total_profit_rollback:.2f} "
        f"profitable={int(sub.symbols_profitable_total)}/24"
    )
print()

# Per-symbol best
print("=" * 80)
print("PER-SYMBOL BEST (by profit_usd_total)")
print("=" * 80)
sym_best = df.loc[df.groupby("symbol")["profit_usd_total"].idxmax()]
sym_best = sym_best.sort_values("profit_usd_total", ascending=False)
for _, r in sym_best.iterrows():
    print(
        f"{r.symbol:<16} w={int(r.window_min):>3} z_ab={r.z_open_ab:.0f} z_ba={r.z_open_ba:.0f} "
        f"profit=${r.profit_usd_total:>8.2f} open=${r.open_profit_usd_total:>7.2f} "
        f"rollback=${r.profit_usd_total_rollback_unopened_fifo:>8.2f} orders={int(r.orders)}"
    )
print()

# Worst performers overall
print("=" * 80)
print("WORST 10 symbol-combos by profit_usd_total")
print("=" * 80)
for _, r in df.nsmallest(10, "profit_usd_total").iterrows():
    print(
        f"{r.symbol:<16} w={int(r.window_min):>3} z_ab={r.z_open_ab:.0f} z_ba={r.z_open_ba:.0f} "
        f"profit=${r.profit_usd_total:>8.2f} orders={int(r.orders)}"
    )
print()

# Global baseline: all combos average
print("=" * 80)
print("OVERALL BASELINE")
print("=" * 80)
print(f"All 3600 rows avg profit_usd_total: ${df['profit_usd_total'].mean():.2f}")
print(f"All 3600 rows avg open_profit: ${df['open_profit_usd_total'].mean():.2f}")
print(f"All 3600 rows avg rollback fifo: ${df['profit_usd_total_rollback_unopened_fifo'].mean():.2f}")
print(f"Profitable rows (total): {(df['profit_usd_total']>0).sum()}/3600")
print(f"Profitable rows (rollback): {(df['profit_usd_total_rollback_unopened_fifo']>0).sum()}/3600")

# Heatmap-style: best z_ab for each window (marginal)
print()
print("=" * 80)
print("MARGINAL EFFECT: avg total profit by window_min (across all z)")
print("=" * 80)
for w, g in df.groupby("window_min")["profit_usd_total"].agg(["mean", "median", "max"]).iterrows():
    print(f"window={int(w):>3}: mean=${g['mean']:>7.2f} median=${g['median']:>7.2f} max=${g['max']:>7.2f}")

print()
print("=" * 80)
print("MARGINAL EFFECT: avg total profit by z_open_ab (across all window/symbols)")
print("=" * 80)
for z, g in df.groupby("z_open_ab")["profit_usd_total"].agg(["mean", "median"]).iterrows():
    print(f"z_ab={z:.0f}: mean=${g['mean']:>7.2f} median=${g['median']:>7.2f}")

print()
print("=" * 80)
print("MARGINAL EFFECT: avg total profit by z_open_ba")
print("=" * 80)
for z, g in df.groupby("z_open_ba")["profit_usd_total"].agg(["mean", "median"]).iterrows():
    print(f"z_ba={z:.0f}: mean=${g['mean']:>7.2f} median=${g['median']:>7.2f}")

g = df.groupby(group_cols).agg(
    total=("profit_usd_total", "sum"),
    open=("open_profit_usd_total", "sum"),
    close=("close_profit_usd_total", "sum"),
    rollback=("profit_usd_total_rollback_unopened_fifo", "sum"),
    n_prof=("profit_usd_total", lambda x: (x > 0).sum()),
).reset_index()
g["score"] = g["rollback"] * 0.6 + g["total"] * 0.4

print()
print("=" * 80)
print("Combos with POSITIVE aggregate total profit")
print("=" * 80)
pos = g[g["total"] > 0].sort_values("total", ascending=False)
print(f"Count: {len(pos)}")
for _, r in pos.iterrows():
    print(
        f"  w={int(r.window_min)} z_ab={r.z_open_ab:.0f} z_ba={r.z_open_ba:.0f} "
        f"total={r.total:.2f} open={r.open:.2f} close={r.close:.2f} "
        f"rollback={r.rollback:.2f} prof={int(r.n_prof)}/24"
    )

print()
print("=" * 80)
print("TOP 5 BALANCED (60% rollback + 40% total)")
print("=" * 80)
for _, r in g.sort_values("score", ascending=False).head(5).iterrows():
    print(
        f"  w={int(r.window_min)} z_ab={r.z_open_ab:.0f} z_ba={r.z_open_ba:.0f} "
        f"score={r.score:.2f} total={r.total:.2f} rollback={r.rollback:.2f} "
        f"prof={int(r.n_prof)}/24"
    )

print()
print("=" * 80)
print("Detail: window=720 z_ab=4 z_ba=0 (best total profit)")
print("=" * 80)
best = df[(df.window_min == 720) & (df.z_open_ab == 4) & (df.z_open_ba == 0)].sort_values(
    "profit_usd_total", ascending=False
)
print(f"Total profit sum: ${best.profit_usd_total.sum():.2f}")
for _, r in best.iterrows():
    sign = "+" if r.profit_usd_total > 0 else ""
    print(
        f"  {r.symbol:<16} profit={sign}{r.profit_usd_total:>8.2f} "
        f"open={r.open_profit_usd_total:>7.2f} close={r.close_profit_usd_total:>8.2f} "
        f"orders={int(r.orders)}"
    )

print()
print("=" * 80)
print("Detail: window=10 z_ab=1 z_ba=3 (best rollback)")
print("=" * 80)
rb = df[(df.window_min == 10) & (df.z_open_ab == 1) & (df.z_open_ba == 3)].sort_values(
    "profit_usd_total_rollback_unopened_fifo", ascending=False
)
for _, r in rb.head(8).iterrows():
    print(
        f"  {r.symbol:<16} rollback={r.profit_usd_total_rollback_unopened_fifo:>8.2f} "
        f"total={r.profit_usd_total:>8.2f} orders={int(r.orders)}"
    )
print("  worst:")
for _, r in rb.nsmallest(3, "profit_usd_total_rollback_unopened_fifo").iterrows():
    print(
        f"  {r.symbol:<16} rollback={r.profit_usd_total_rollback_unopened_fifo:>8.2f} "
        f"total={r.profit_usd_total:>8.2f}"
    )

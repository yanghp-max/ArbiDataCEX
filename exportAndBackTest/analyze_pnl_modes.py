import pandas as pd

OLD_PATH = r"c:\Users\yanghongpeng\Desktop\summary_open_only.csv"
NEW_PATH = r"c:\Users\yanghongpeng\Desktop\summary_open_only1.csv"
GROUP_COLS = ["window_min", "z_open_ab", "z_open_ba"]


def agg_by_combo(df: pd.DataFrame, profit_col: str) -> pd.DataFrame:
    return (
        df.groupby(GROUP_COLS)
        .agg(
            total_profit=(profit_col, "sum"),
            avg_profit=(profit_col, "mean"),
            median_profit=(profit_col, "median"),
            n_profitable=(profit_col, lambda x: (x > 0).sum()),
            n_symbols=("symbol", "count"),
            total_orders=("orders", "sum"),
            total_open=("open_profit_usd_total", "sum"),
        )
        .reset_index()
    )


def print_top(title: str, data: pd.DataFrame, sort_col: str, n: int = 10) -> None:
    print("=" * 88)
    print(title)
    print("=" * 88)
    for _, r in data.sort_values(sort_col, ascending=False).head(n).iterrows():
        print(
            f"w={int(r.window_min):>3} z_ab={r.z_open_ab:.0f} z_ba={r.z_open_ba:.0f} | "
            f"total=${r.total_profit:>9.2f} avg=${r.avg_profit:>7.2f} med=${r.median_profit:>7.2f} | "
            f"prof={int(r.n_profitable)}/{int(r.n_symbols)} open=${r.total_open:>9.2f} orders={int(r.total_orders)}"
        )
    print()


def analyze_old() -> None:
    df = pd.read_csv(OLD_PATH)
    print(f"\n### 旧版回测（含 close_orders）: {OLD_PATH}")
    print(f"rows={len(df)} symbols={df.symbol.nunique()}")

    metrics = {
        "last_tick（末尾按最后价强平）": "profit_usd_total_last_tick",
        "rollback_FIFO（先开先回滚/前面未平）": "profit_usd_total_rollback_unopened_fifo",
        "rollback_LIFO（后开先回滚/后面未平）": "profit_usd_total_rollback_unopened_lifo",
    }

    best_rows = {}
    for label, col in metrics.items():
        agg = agg_by_combo(df, col)
        print_top(f"TOP 10 by {label}", agg, "total_profit")
        best = agg.loc[agg["total_profit"].idxmax()]
        best_rows[label] = best

    print("=" * 88)
    print("三种口径最优组合对比")
    print("=" * 88)
    for label, r in best_rows.items():
        print(
            f"{label:<34} w={int(r.window_min):>3} z_ab={r.z_open_ab:.0f} z_ba={r.z_open_ba:.0f} "
            f"total=${r.total_profit:>9.2f} prof={int(r.n_profitable)}/{int(r.n_symbols)}"
        )

    # robust: >=70% symbols profitable
    print()
    print("=" * 88)
    print("稳健组合：单币盈利占比 >= 70%")
    print("=" * 88)
    for label, col in metrics.items():
        agg = agg_by_combo(df, col)
        n_sym = int(agg["n_symbols"].iloc[0])
        need = int(n_sym * 0.7)
        sub = agg[agg["n_profitable"] >= need].sort_values("total_profit", ascending=False)
        if len(sub) == 0:
            print(f"{label}: 无满足条件的组合")
            continue
        r = sub.iloc[0]
        print(
            f"{label:<34} w={int(r.window_min):>3} z_ab={r.z_open_ab:.0f} z_ba={r.z_open_ba:.0f} "
            f"total=${r.total_profit:>9.2f} prof={int(r.n_profitable)}/{int(r.n_symbols)}"
        )

    # per window best under each metric
    print()
    print("=" * 88)
    print("各窗口最优（三种口径）")
    print("=" * 88)
    for w in sorted(df["window_min"].unique()):
        parts = []
        for label, col in metrics.items():
            sub = agg_by_combo(df[df.window_min == w], col)
            r = sub.sort_values("total_profit", ascending=False).iloc[0]
            short = "tick" if "tick" in label else ("fifo" if "FIFO" in label else "lifo")
            parts.append(f"{short}={r.total_profit:.0f}(z{r.z_open_ab:.0f}/{r.z_open_ba:.0f})")
        print(f"window={int(w):>3}: " + " | ".join(parts))

    # fifo vs lifo diff
    agg_fifo = agg_by_combo(df, metrics["rollback_FIFO（先开先回滚/前面未平）"])
    agg_lifo = agg_by_combo(df, metrics["rollback_LIFO（后开先回滚/后面未平）"])
    merged = agg_fifo.merge(
        agg_lifo,
        on=GROUP_COLS,
        suffixes=("_fifo", "_lifo"),
    )
    merged["delta"] = merged["total_profit_lifo"] - merged["total_profit_fifo"]
    print()
    print("=" * 88)
    print("FIFO vs LIFO 差异最大的组合（LIFO - FIFO）")
    print("=" * 88)
    for _, r in merged.reindex(merged["delta"].abs().sort_values(ascending=False).index).head(5).iterrows():
        print(
            f"w={int(r.window_min):>3} z_ab={r.z_open_ab:.0f} z_ba={r.z_open_ba:.0f} | "
            f"fifo=${r.total_profit_fifo:>9.2f} lifo=${r.total_profit_lifo:>9.2f} delta=${r.delta:>8.2f}"
        )


def analyze_new() -> None:
    df = pd.read_csv(NEW_PATH)
    print(f"\n### 新版 netting 回测: {NEW_PATH}")
    print(f"rows={len(df)} symbols={df.symbol.nunique()}")
    print(f"orders==ab+ba: {(df.orders == df.orders_side_ab + df.orders_side_ba).all()}")

    print_top("TOP 10 by open_profit_usd_total（仅成交 PnL，不处理末尾未平）", agg_by_combo(df, "open_profit_usd_total"), "total_profit")
    print_top("TOP 10 by profit_usd_total（末尾 last_tick 强平未平仓位）", agg_by_combo(df, "profit_usd_total"), "total_profit")

    for col, label in [
        ("open_profit_usd_total", "open only"),
        ("profit_usd_total", "last_tick"),
    ]:
        agg = agg_by_combo(df, col)
        r = agg.loc[agg["total_profit"].idxmax()]
        print(f"最优({label}): w={int(r.window_min)} z_ab={r.z_open_ab:.0f} z_ba={r.z_open_ba:.0f} total=${r.total_profit:.2f} prof={int(r.n_profitable)}/{int(r.n_symbols)}")


def compare_fifo_lifo() -> None:
    df = pd.read_csv(OLD_PATH)
    agg_fifo = agg_by_combo(df, "profit_usd_total_rollback_unopened_fifo")
    agg_lifo = agg_by_combo(df, "profit_usd_total_rollback_unopened_lifo")
    merged = agg_fifo.merge(agg_lifo, on=GROUP_COLS, suffixes=("_fifo", "_lifo"))
    merged["delta"] = merged["total_profit_lifo"] - merged["total_profit_fifo"]
    same = (merged["delta"].abs() < 0.01).sum()
    print("\n### FIFO vs LIFO 总体")
    print(f"150 组参数中几乎相同: {same}/150")
    print(f"LIFO 略好: {(merged['delta'] > 0.01).sum()} 组 | FIFO 略好: {(merged['delta'] < -0.01).sum()} 组")
    print(f"最大 LIFO 优势: ${merged['delta'].max():.2f} | 最大 FIFO 优势: ${merged['delta'].min():.2f}")


def main() -> None:
    analyze_old()
    compare_fifo_lifo()
    analyze_new()


if __name__ == "__main__":
    main()

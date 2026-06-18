import json
import csv
import io
from collections import OrderedDict

path = r"C:\Users\yanghongpeng\.cursor\projects\d-code-bscProject-ArbiDataCEX\agent-transcripts\f568a430-752f-4c80-82b4-5137b51b5ded\f568a430-752f-4c80-82b4-5137b51b5ded.jsonl"
HEADER = (
    "timestamp_ms,timestamp_iso,symbol,action,direction,locked_direction,a_bid,a_ask,b_bid,b_ask,"
    "spread_ab_pct,spread_ba_pct,a_side,a_price_nominal,b_side,b_price_nominal,accept_a_price,accept_b_price,"
    "send_a_price,send_b_price,a_fill_price,b_fill_price,qty,a_filled_qty,b_filled_qty,a_order_id,b_order_id,"
    "a_usdt_change,b_usdt_change,a_fee,b_fee,gross_pnl,fee_cost,net_pnl,cum_pnl,a_pos_qty,b_pos_qty,"
    "leg_mismatch,leg_exposure,failed_leg,fail_reason,lat_ws_push_ms,lat_receive_ms,lat_ws_transit_ms,"
    "lat_decision_to_order_ms,lat_ws_push_to_order_ms,lat_receive_to_order_ms,lat_price_age_at_order_ms,"
    "lat_a_age_ms,lat_b_age_ms,lat_leg_skew_ms,lat_a_ws_transit_ms,lat_b_ws_transit_ms,lat_stage_calc_ms,"
    "lat_stage_account_ms,lat_stage_reserve_ms,lat_stage_queue_ms,lat_stage_fresh_tick_ms,lat_stage_precheck_ms,"
    "lat_stage_presend_ms,lat_stage_order_send_ms,lat_decision_to_submit_done_ms,lat_local_old_to_order_ms,"
    "lat_local_new_to_order_ms,lat_old_data_freshness_ms,lat_new_data_freshness_ms,local_span_old_to_new_ms,"
    "official_span_old_to_new_ms"
)

# Collect from all user messages with trade rows (178... timestamps)
by_ts = OrderedDict()
for line in open(path, encoding="utf-8"):
    obj = json.loads(line)
    if obj.get("role") != "user":
        continue
    text = obj.get("message", {}).get("content", [{}])[0].get("text", "")
    for l in text.split("\n"):
        if not l.startswith("178"):
            continue
        if "2026-06-17" not in l and "2026-06-18" not in l:
            continue
        try:
            r = next(csv.DictReader(io.StringIO(HEADER + "\n" + l)))
        except Exception:
            continue
        by_ts[r["timestamp_ms"]] = r

rows = list(by_ts.values())
rows.sort(key=lambda r: int(r["timestamp_ms"]))

print(f"total unique rows (6/17 + 6/18): {len(rows)}\n")
print(
    f"{'#':>2}  {'日期':10}  {'时间':8}  {'品种':12}  {'动作':5}  "
    f"{'A ws':>5}  {'B ws':>5}  {'A age':>5}  {'B age':>5}  {'pnl':>8}"
)
for i, r in enumerate(rows, 1):
    d = r["timestamp_iso"][:10]
    t = r["timestamp_iso"][11:19]
    a = int(float(r["lat_a_ws_transit_ms"]))
    b = int(float(r["lat_b_ws_transit_ms"]))
    aa = int(float(r["lat_a_age_ms"]))
    ba = int(float(r["lat_b_age_ms"]))
    pnl = float(r["net_pnl"])
    flag = " ***" if d == "2026-06-18" else ""
    print(
        f"{i:2}  {d}  {t}  {r['symbol']:12}  {r['action']:5}  "
        f"{a:5}  {b:5}  {aa:5}  {ba:5}  {pnl:8.4f}{flag}"
    )

d17 = [r for r in rows if r["timestamp_iso"].startswith("2026-06-17")]
d18 = [r for r in rows if r["timestamp_iso"].startswith("2026-06-18")]

def stats(vals):
    return min(vals), max(vals), round(sum(vals) / len(vals), 1)

for label, subset in [("6/17", d17), ("6/18", d18)]:
    if not subset:
        continue
    a = [int(float(r["lat_a_ws_transit_ms"])) for r in subset]
    b = [int(float(r["lat_b_ws_transit_ms"])) for r in subset]
    in10_a = sum(1 for x in a if 2 <= x <= 10)
    in10_b = sum(1 for x in b if 2 <= x <= 10)
    print(f"\n{label} n={len(subset)}  A ws {stats(a)}  in2-10: {in10_a}/{len(a)}  "
          f"B ws {stats(b)}  in2-10: {in10_b}/{len(b)}")

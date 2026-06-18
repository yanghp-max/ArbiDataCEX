import json
import csv
import io

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

seen = set()
raw_lines = []
for line in open(path, encoding="utf-8"):
    obj = json.loads(line)
    if obj.get("role") != "user":
        continue
    text = obj.get("message", {}).get("content", [{}])[0].get("text", "")
    if "2026-06-18" not in text:
        continue
    for l in text.split("\n"):
        if l.startswith("178") and "2026-06-18" in l and l not in seen:
            seen.add(l)
            raw_lines.append(l)

parsed = []
for l in raw_lines:
    parsed.append(next(csv.DictReader(io.StringIO(HEADER + "\n" + l))))
parsed.sort(key=lambda r: int(r["timestamp_ms"]))

print(f"6/18 rows: {len(parsed)}\n")
print(f"{'#':>2}  {'时间(UTC)':19}  {'品种':12}  {'动作':5}  {'A transit':>9}  {'B transit':>9}  {'A age':>6}  {'B age':>6}")
for i, r in enumerate(parsed, 1):
    a = int(float(r["lat_a_ws_transit_ms"]))
    b = int(float(r["lat_b_ws_transit_ms"]))
    aa = int(float(r["lat_a_age_ms"]))
    ba = int(float(r["lat_b_age_ms"]))
    print(
        f"{i:2}  {r['timestamp_iso'][:19]}  {r['symbol']:12}  {r['action']:5}  {a:9}  {b:9}  {aa:6}  {ba:6}"
    )

a_vals = [int(float(r["lat_a_ws_transit_ms"])) for r in parsed]
b_vals = [int(float(r["lat_b_ws_transit_ms"])) for r in parsed]
print(f"\nA transit: min={min(a_vals)} max={max(a_vals)} all>50={all(x>50 for x in a_vals)}")
print(f"B transit: min={min(b_vals)} max={max(b_vals)} in_2_10={sum(1 for x in b_vals if 2<=x<=10)}/{len(b_vals)}")

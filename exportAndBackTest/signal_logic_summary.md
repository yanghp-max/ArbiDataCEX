# CEX-CEX 回测信号逻辑（单独说明）

本文档仅总结 `backtest_cex_cex_open_only.py` 的信号部分逻辑。

## 1. 基础定义

- 交易所映射：`A = Binance`，`B = Gate`
- 两个方向：
  - `-a+b`：对应 `spread_ab`  => (a_bid - b_ask) / b_ask * 100
  - `+a-b`：对应 `spread_ba`  => (b_bid - a_ask) / a_ask * 100

## 2. 成本处理后的价差

先把成本扣到价差里：

- `spread_ab_adj = spread_ab - total_cost_pct`
- `spread_ba_adj = spread_ba - total_cost_pct`

其中：
<!-- 手续费 -->
- `total_cost_pct = (fee_bps_total + slippage_bps_total) / 100`
- 默认手续费双边万4、滑点双边万4，总计万8（0.08%）

## 3. 滚动统计（每个窗口分别算）

对每个窗口（默认 `10m, 30m, 1h, 3h, 6h, 12h`）：

- `median_ab`：`spread_ab`（原始价差，不扣手续费/滑点）的滚动中位数
- `median_ba`：`spread_ba`（原始价差，不扣手续费/滑点）的滚动中位数
- `mad_ab`：`median(|spread_ab - median_ab|)`
- `mad_ba`：`median(|spread_ba - median_ba|)`

异常处理：

- 如果 `mad_ab/mad_ba` 为 0 或空，z 分数会变成 `NaN`
- 该条数据点会被直接跳过，不参与开仓判断

## 4. z-score 信号

- `z_ab = (spread_ab_adj - median_ab) / mad_ab`
- `z_ba = (spread_ba_adj - median_ba) / mad_ba`

解释：

- `z_ab` 衡量 `-a+b` 方向当前偏离强度
- `z_ba` 衡量 `+a-b` 方向当前偏离强度

## 5. 双阈值开仓条件

脚本使用两个独立阈值：

- `z_open_ab`（用于 `z_ab`）
- `z_open_ba`（用于 `z_ba`）

开仓判定：

- `-a+b` 可开：`z_ab >= z_open_ab`
- `+a-b` 可开：`z_ba >= z_open_ba`

若两个方向都不满足：不下单。

## 6. 同时触发时的方向选择

当两个方向同一时刻都满足阈值：

- 若 `z_ab >= z_ba`，选择 `-a+b`
- 否则选择 `+a-b`

即：优先选择 z-score 更大的方向。

## 7. 信号前置过滤（在阈值前后都会挡单）

即便 z 满足，也会被这些条件拦截：

- funding 为空（任一边 `NaN`）不下单
- funding 小于阈值（默认 `< -0.1`）不下单
- 1 秒频率限制（`cooldown_ms=1000`）
- 仓位上限限制（数量维度）：
  - 每次开仓先用 A 腿价格把 `order_usd` 换算成 `qty`
  - `-a+b`：`qty = order_usd / a_bid`
  - `+a-b`：`qty = order_usd / a_ask`
  - 最大持仓也用 A 腿价格转成数量：
    - `-a+b`：`max_position_qty = max_position_usd / a_bid`
    - `+a-b`：`max_position_qty = max_position_usd / a_ask`
  - 若更新后 A/B 任一腿数量绝对值会超 `max_position_qty`，不直接拦截：
    - 先把本次 `qty` 截断到“当前可用剩余仓位”
    - 再做数量凑整
    - 只有截断后 `qty` 接近 0，才跳过该次信号
- 价差硬过滤：`adj_spread` 必须在 `[0, 10]` 区间

## 8. 参数扫描维度（与信号直接相关）

每个币种最终会对以下组合逐一回测：

- `window_min_list`
- `z_open_ab_list`
- `z_open_ba_list`

组合数 = `窗口数 × ab阈值个数 × ba阈值个数`。

## 9. 下单流程（数量模型）

每个时间点在通过信号与过滤条件后，下单流程如下：

1. 判定方向（`-a+b` 或 `+a-b`）。
2. 用 A 腿价格换算数量：
   - `-a+b`：`qty = order_usd / a_bid`
   - `+a-b`：`qty = order_usd / a_ask`
3. 按同一 `qty` 执行分腿数量仓位更新：
   - `-a+b`：`A_qty -= qty`，`B_qty += qty`
   - `+a-b`：`A_qty += qty`，`B_qty -= qty`
4. 每次开仓前按 A 腿价格计算 `max_position_qty`；若超限则将本次 `qty` 截断到可用上限并凑整，仅当截断后 `qty` 接近 0 才跳过。

## 10. PnL 计算流程

### 10.1 开仓阶段 PnL（逐单累加）

- 先按 A 腿价格换算统一数量：
  - `-a+b`：`qty = order_usd / a_bid`
  - `+a-b`：`qty = order_usd / a_ask`
- 每笔毛收益（直接按两腿价格计算，和强平口径一致）：
  - `-a+b`（A 开空、B 开多）：
    - `gross = qty * a_bid - qty * b_ask`
  - `+a-b`（A 开多、B 开空）：
    - `gross = qty * b_bid - qty * a_ask`
- 分腿成交额（用于手续费）：
  - `-a+b`：`a_leg_value = qty * a_bid`，`b_leg_value = qty * b_ask`
  - `+a-b`：`a_leg_value = qty * a_ask`，`b_leg_value = qty * b_bid`
- 每笔成本（双边分别计费，合计万8）：
  - `fee_cost = abs(a_leg_value) * 0.0004 + abs(b_leg_value) * 0.0004`
- 每笔净收益：
  - `trade_pnl_usd = gross - fee_cost`
- 开仓累计：
  - `open_profit_usd_total = Σ(trade_pnl_usd)`

### 10.2 回测末尾强平 PnL

- 若最后 `A/B` 分腿数量仓位不为 0，执行强平估算。
- 强平数量：
  - `close_qty = min(abs(a_pos_qty), abs(b_pos_qty))`
- 强平收益按两腿价格直接算（你指定口径：`qty*price - qty*price`）：
  - 关闭 `-a+b`（`a_pos_qty < 0`）：
    - `gross_close = close_qty * b_bid - close_qty * a_ask`
  - 关闭 `+a-b`（`a_pos_qty > 0`）：
    - `gross_close = close_qty * a_bid - close_qty * b_ask`
- 强平分腿成交额（用于手续费）：
  - 关闭 `-a+b`：`a_close_leg = close_qty * a_ask`，`b_close_leg = close_qty * b_bid`
  - 关闭 `+a-b`：`a_close_leg = close_qty * a_bid`，`b_close_leg = close_qty * b_ask`
- 强平成本（双边分别计费，合计万8）：
  - `close_fee = abs(a_close_leg) * 0.0004 + abs(b_close_leg) * 0.0004`
- 强平净收益：
  - `close_profit_usd_total = gross_close - close_fee`

### 10.3 最终总收益

- `profit_usd_total = open_profit_usd_total + close_profit_usd_total`

强平后汇总里的分腿数量仓位会置为：

- `final_a_position_qty = 0`
- `final_b_position_qty = 0`
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

- `median_ab`：`spread_ab_adj` 的滚动中位数
- `median_ba`：`spread_ba_adj` 的滚动中位数
- `mad_ab`：`median(|spread_ab_adj - median_ab|)`
- `mad_ba`：`median(|spread_ba_adj - median_ba|)`

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
  - 每次开仓数量由 `order_usd / 当前 Binance 价格` 换算
  - 每次开仓前动态计算 `max_position_qty = max_position_usd / 当前 Binance 价格`
  - 同向加仓后若超过 `max_position_qty`，不拦截，改为把本次 `order_qty` 截断到“剩余可用仓位”
  - 截断后会做数量凑整；若截断后数量接近 0，则该次信号跳过
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
2. 用 Binance 实时价格把 `order_usd` 换算为本次开仓数量：
   - `-a+b`：`order_qty = order_usd / a_bid`
   - `+a-b`：`order_qty = order_usd / a_ask`
   - 该 `order_qty` 作为双边统一数量（Binance 与 Gate 两腿使用同一个数量）
3. 同步计算动态最大仓位数量（max_position_usd = 20000U）：
   - `max_position_qty = max_position_usd / 当前 Binance 价格`
4. 执行同向加仓限制（超限截断），net_pos_qty（当前净仓）：
   - `-a+b` 方向：若 `net_pos_qty >= 0` 且 `net_pos_qty + order_qty > max_position_qty`，则 
   - `order_qty = max_position_qty - net_pos_qty`
   - `+a-b` 方向：若 `net_pos_qty <= 0` 且 `abs(net_pos_qty) + order_qty > max_position_qty`，则
     - `order_qty = max_position_qty - abs(net_pos_qty)`
   - 截断后执行凑整；若 `order_qty` 接近 0，则跳过本次信号
5. 通过后更新净仓：
   - `-a+b`：`net_pos_qty += order_qty`
   - `+a-b`：`net_pos_qty -= order_qty`

> 注意：这里只是“回测成交估算”，并未引入交易所最小下单量/步长取整。

## 10. PnL 计算流程

### 10.1 开仓阶段 PnL（逐单累加）

- 每笔开仓名义金额（实际花了多少U）：`executed_notional_usd = order_qty * 当前 Binance 价格`
- 每笔收益估算：
  - `trade_pnl_usd = executed_notional_usd * adj_spread(扣完成本的价差) / 100`
- 开仓累计收益：
  - `open_profit_usd_total = Σ(trade_pnl_usd)`

### 10.2 回测末尾强平 PnL

- 若 `net_pos_qty != 0`，在最后一条行情执行一次强平估算。
- 先确定强平使用的净价差：
  - `net_pos_qty > 0` -> 用 `spread_ab_adj`
  - `net_pos_qty < 0` -> 用 `spread_ba_adj`
- 再把剩余数量换算为名义 U（最后时刻 Binance 参考价格）：
  - `close_notional_usd = abs(net_pos_qty_before_close) * close_ref_price`
- 强平收益：
  - `close_profit_usd_total = close_notional_usd * close_spread_used / 100`

### 10.3 最终总收益

- `profit_usd_total = open_profit_usd_total + close_profit_usd_total`

强平后汇总里的净仓位会置为：

- `final_net_position_qty = 0`
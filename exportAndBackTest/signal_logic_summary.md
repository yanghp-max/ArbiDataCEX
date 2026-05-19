# CEX-CEX 回测信号逻辑（单独说明）

本文档仅总结 `backtest_cex_cex_open_only.py` 的信号部分逻辑。

## 1. 基础定义

- 交易所映射：`A = Binance`，`B = Gate`
- 两个方向：
  - `-a+b`：对应 `spread_ab`
  - `+a-b`：对应 `spread_ba`

## 2. 成本处理后的价差

先把成本扣到价差里：

- `spread_ab_adj = spread_ab - total_cost_pct`
- `spread_ba_adj = spread_ba - total_cost_pct`

其中：

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
- 仓位上限限制（单方向净仓绝对值不超过 `max_position_usd`）
- 价差硬过滤：`adj_spread` 必须在 `[0, 10]` 区间

## 8. 参数扫描维度（与信号直接相关）

每个币种最终会对以下组合逐一回测：

- `window_min_list`
- `z_open_ab_list`
- `z_open_ba_list`

组合数 = `窗口数 × ab阈值个数 × ba阈值个数`。

## 9. 回测末尾强平逻辑（补充）

信号用于开仓后，脚本在回测末尾会做一次强平估算：

- 若 `final_net_position_usd > 0`，用最后一条的 `spread_ab_adj` 估算强平
- 若 `final_net_position_usd < 0`，用最后一条的 `spread_ba_adj` 估算强平

强平利润：

- `close_profit_usd_total = abs(final_net_position_usd_before_close) * close_spread_used / 100`

最终总利润：

- `profit_usd_total = open_profit_usd_total + close_profit_usd_total`

强平后汇总里的净仓位会置为：

- `final_net_position_usd = 0`

### 9.1 强平相关字段解释

- `net_pos_usd`
  - 含义：当前净仓（美元名义）。
  - 方向：
    - `> 0` 表示净多 `-a+b` 方向仓位更多
    - `< 0` 表示净多 `+a-b` 方向仓位更多
  - 单位：`USDT`

- `spread_ab_adj`
  - 含义：`-a+b` 方向的扣成本后净价差（已经减去双边手续费+滑点）。
  - 单位：百分比点（`%`）

- `spread_ba_adj`
  - 含义：`+a-b` 方向的扣成本后净价差。
  - 单位：百分比点（`%`）

- `close_spread_used`
  - 含义：强平时实际采用的末尾净价差。
  - 选择规则：
    - `net_pos_usd > 0` 用最后一条 `spread_ab_adj`
    - `net_pos_usd < 0` 用最后一条 `spread_ba_adj`
  - 单位：百分比点（`%`）

- `close_profit_usd_total`
  - 含义：末尾强平贡献的利润汇总。
  - 公式：
    - `close_profit_usd_total = abs(net_pos_usd_before_close) * close_spread_used / 100`
  - 单位：`USDT`

- `open_profit_usd_total`
  - 含义：开仓阶段累计利润（按每次开仓时净价差估算）。
  - 单位：`USDT`

- `profit_usd_total`
  - 含义：最终总利润。
  - 公式：
    - `profit_usd_total = open_profit_usd_total + close_profit_usd_total`
  - 单位：`USDT`

- `final_net_position_usd`
  - 含义：回测结束后的净仓位。
  - 在当前实现里，强平执行后固定置为 `0`。

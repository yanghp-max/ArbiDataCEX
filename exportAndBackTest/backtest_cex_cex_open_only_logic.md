# CEX-CEX Open-Only 回测逻辑说明

本文档说明 `exportAndBackTest/backtest_cex_cex_open_only.py` 的整体流程与核心规则。

---

## 1. 目标与范围

- 策略类型：`CEX-CEX`（Binance = A，Gate = B）
- 交易动作：**只开仓，不平仓**
- 开仓方向：
  - `-a+b`：Binance 开空 + Gate 开多
  - `+a-b`：Binance 开多 + Gate 开空
- 统计核心：`中位数 (median) + MAD`
- 扫描维度：
  - 多窗口（代码写死）
  - 双阈值扫描：`z_open_ab_list × z_open_ba_list`

---

## 2. 输入与读取

- 输入目录：`--data_dir`（默认 `./data/meta_data`）
- 输入格式：每个币种一个 CSV（如 `BTCUSDT.csv`）
- 脚本会自动扫描目录下 `*.csv`
- 可选 `--symbols` 指定子集（逗号分隔）

读取步骤：

1. `pd.read_csv(path)`
2. 解析并清洗 `timestamp`
3. 常见数值字段强制转数值（空字符串会变为 `NaN`）
4. 如果没有 `spread_ab/spread_ba`，尝试用买一卖一推导

---

## 3. 成本与价差处理

先把交易成本计提到 spread：

- 双边手续费：默认万4（`fee_bps_total=4`）
- 双边滑点：默认万4（`slippage_bps_total=4`）
- 总成本：万8 = `0.08%`

定义：

- `spread_ab_adj = spread_ab - 0.08`
- `spread_ba_adj = spread_ba - 0.08`

> 注意：这里 spread 单位是“百分比点”，所以直接减 `0.08`。

---

## 4. 滚动窗口统计（median + MAD）

固定窗口列表（代码常量）：

- `WINDOW_MIN_LIST_FIXED = [10, 30, 60, 180, 360, 720]`
- 即 `10m / 30m / 1h / 3h / 6h / 12h`

每个窗口下分别计算：

- `median_ab`：`spread_ab`（原始价差）的滚动中位数
- `median_ba`：`spread_ba`（原始价差）的滚动中位数
- `mad_ab`：`median(|spread_ab - median_ab|)`
- `mad_ba`：`median(|spread_ba - median_ba|)`

分母异常处理：

- `mad_ab/mad_ba` 若为 0 或空，`z` 会变成空值（`NaN`）
- 这类点在回测循环中会直接跳过，不参与开仓判断

---

## 5. z-score 构造

### 5.1 标准化偏离（z）

- `z_ab = (spread_ab_adj - median_ab) / mad_ab`
- `z_ba = (spread_ba_adj - median_ba) / mad_ba`

## 6. 开仓判定与风控

### 6.1 基础开仓条件（双 zscore / 双阈值）

- `-a+b` 可开：
  - `z_ab >= z_open_ab`
- `+a-b` 可开：
  - `z_ba >= z_open_ba`

### 6.2 方向选择

若两个方向同时满足，比较 z-score 大小：

- `z_ab >= z_ba` -> 选 `-a+b`
- 否则选 `+a-b`

### 6.3 资金费率过滤

任一边满足以下任意条件，都不开仓：

- funding 为空（`NaN`）
- funding 小于阈值（默认 `-0.1`）

### 6.4 下单频率与仓位上限

- 每秒最多 1 单（`cooldown_ms=1000`）
- 每次开仓先按 A 腿价格把 `order_usd` 转成数量：
  - `-a+b`：`qty = order_usd / a_bid`
  - `+a-b`：`qty = order_usd / a_ask`
- 分腿仓位按数量更新：
  - `-a+b`：A 数量 `-qty`，B 数量 `+qty`
  - `+a-b`：A 数量 `+qty`，B 数量 `-qty`
- 仓位上限也转成数量控制：
  - `max_position_qty = max_position_usd / 当前 A 腿价格`
  - 若开仓后任一腿会超上限，不直接拦截：
    - 本次 `qty` 截断为“可用剩余仓位”
    - 对截断结果做统一凑整
    - 仅当截断后 `qty` 接近 0 时，才跳过本次信号

### 6.5 回测末尾强平/回滚（3 种口径）

- 回测遍历结束后，如果分腿数量仓位不为 0，会计算 `close_qty = min(abs(a_pos_qty), abs(b_pos_qty))`。
- 当前脚本并行输出 3 种末尾处理口径：

1. `last_tick`（最后一条记录反向平仓）
   - 若 `a_pos_qty < 0`（关闭 `-a+b`）：A 用 `a_ask`，B 用 `b_bid`
   - 若 `a_pos_qty > 0`（关闭 `+a-b`）：A 用 `a_bid`，B 用 `b_ask`
   - `close_profit_last_tick = gross_close - close_fee`

2. `rollback_unopened_fifo`（未平仓回滚，FIFO）
   - 用 FIFO 持仓簿把未对冲剩余仓位对应的开仓净收益扣回
   - `close_profit_rollback_unopened_fifo = - Σ(remaining_open_net_pnl_fifo)`

3. `rollback_unopened_lifo`（未平仓回滚，LIFO）
   - 用 LIFO 持仓簿做同样回滚
   - `close_profit_rollback_unopened_lifo = - Σ(remaining_open_net_pnl_lifo)`

- 主汇总口径默认使用 `last_tick`：
  - `close_profit_usd_total = close_profit_last_tick`
  - `profit_usd_total = open_profit_usd_total + close_profit_last_tick`
- 同时输出对比字段：
  - `profit_usd_total_last_tick`
  - `profit_usd_total_rollback_unopened_fifo`
  - `profit_usd_total_rollback_unopened_lifo`
- 末尾处理完成后：
  - `final_a_position_qty = 0.0`
  - `final_b_position_qty = 0.0`

---

## 7. 扫描流程（窗口 x 双阈值）

外层循环：窗口列表  
中层循环：`z_open_ab_list`  
内层循环：`z_open_ba_list`  
最内层：逐币种文件

即会执行：

1. 某个窗口（如 30m）
2. 某个 `z_open_ab`（如 2.0）
3. 某个 `z_open_ba`（如 3.0）
4. 对所有币种 CSV 跑一遍

---

## 8. 输出结果

每个 `window + z_open_ab + z_open_ba + symbol` 会输出：

- 订单明细：
  - 汇总文件（多进程模式）：写入 `summary_open_only.csv`
- 信号明细：
  - 汇总字段包含双阈值，不再使用单 `z_open`

全局汇总：

- `summary_open_only.csv`
  - 粒度：`window_min + z_open_ab + z_open_ba + symbol`
- `z_open_comparison.csv`
  - 聚合维度：`window_min + z_open_ab + z_open_ba`
  - 指标：`total_orders`, `total_profit_usd`, `avg_profit_per_symbol`, `avg_orders_per_symbol`

利润字段说明：

- 逐单利润：`profit_usd = 毛收益(a_qty*价格 - b_qty*价格) - 双边手续费(每腿万4)`
- 开仓累计：`open_profit_usd_total = Σ(open_trade_pnl)`
- 末尾口径对比：
  - `close_profit_last_tick`
  - `close_profit_rollback_unopened_fifo`
  - `close_profit_rollback_unopened_lifo`
- 对应总收益：
  - `profit_usd_total_last_tick`
  - `profit_usd_total_rollback_unopened_fifo`
  - `profit_usd_total_rollback_unopened_lifo`
- 兼容字段：
  - `close_profit_usd_total` 与 `profit_usd_total` 默认等于 `last_tick` 口径

---

## 9. 常用参数

- `--data_dir`：输入目录
- `--output_dir`：输出目录
- `--z_open_ab_list`：`-a+b` 方向阈值列表
- `--z_open_ba_list`：`+a-b` 方向阈值列表
- `--symbols`：指定币种子集
- `--order_usd`：单笔金额（默认 100）
- `--max_position_usd`：单币最大仓位（默认 2000）
- `--cooldown_ms`：最小下单间隔（默认 1000ms）
- `--funding_min`：资金费率下限（默认 -0.1）
- `--fee_bps_total`：双边手续费（默认 4 bps）
- `--slippage_bps_total`：双边滑点（默认 4 bps）

---

## 10. 当前版本特点

- 使用滚动窗口（时间窗口）做稳健统计
- 不做平仓逻辑，纯开仓信号评估
- 成本前置到 spread，更贴近可执行空间
- 支持批量参数扫描，便于选 `window` 与双阈值组合


# CEX-CEX Demo

该目录包含两个脚本：

- `fetch-min-order-qty.js`：查询 Binance + Gate 最小下单量并输出 JSON（支持传币种数组，格式必须是 `XXXUSDT`，用于永续合约）
- `run-cex-cex-arb-demo.js`：60 分钟窗口的 cex-cex 套利 demo，固定阈值 `z_ab=4`、`z_ba=1`

## 1) 生成最小下单量 JSON

```bash
npm run demo:fetch-min-qty -- --symbols BTCUSDT,ETHUSDT --output demo/min-order-qty.json
```

也支持数组写法（注意引号）：

```bash
npm run demo:fetch-min-qty -- --symbols '["BTCUSDT","ETHUSDT"]' --output demo/min-order-qty.json
```

输出结构示例：

```json
{
  "symbols": {
    "BTCUSDT": {
      "binance": {
        "minQty": 0.001,
        "stepSize": 0.001
      },
      "gate": {
        "minQty": 1,
        "stepSize": 1,
        "quantoMultiplier": 0.0001,
        "minBaseQty": 0.0001
      }
    }
  }
}
```

## 2) 启动套利 demo（默认 dry-run）

```bash
npm run demo:arb -- --symbol BTCUSDT --min_qty_json demo/min-order-qty.json
```

说明：

- 默认只打印信号和下单意图，不会真实下单
- 启动后会从 `--min_qty_json` 读取该币在 Binance/Gate 的最小下单量配置
- 下单量会按最小下单量和步进做向下取整
- 不读取历史数据，必须先累计满 60 分钟实时窗口后，才开始计算 z-score 与执行套利

## 3) 真实下单模式（--live）

```bash
npm run demo:arb -- --symbol BTCUSDT --min_qty_json demo/min-order-qty.json --live
```

需要环境变量：

- `BINANCE_API_KEY`
- `BINANCE_API_SECRET`
- `GATE_API_KEY`
- `GATE_API_SECRET`

可选：

- `BINANCE_REST_URL`
- `GATE_REST_URL`

## 4) 策略逻辑（固定参数）

- 窗口：60 分钟
- 开仓阈值：`z_ab >= 4` 或 `z_ba >= 1`
- 成本扣减：`spread_adj = spread - 0.08`
- 方向：
  - `-a+b`：Binance 卖出（空）+ Gate 买入（多）
  - `+a-b`：Binance 买入（多）+ Gate 卖出（空）


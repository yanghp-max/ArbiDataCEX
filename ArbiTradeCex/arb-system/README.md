# arb-system

CEX-CEX 套利核心。结构对齐 ArbiTrade-1/arb-system。

## 模块

| 目录 | 说明 |
|------|------|
| `strategies/` | 生产入口 |
| `arbitrage/task-manager/` | TaskManager、CexCexTask |
| `arbitrage/cache/` | AccountCache、ReservationManager（原子预占） |
| `arbitrage/calculator/` | RollingSignalEngine（1s 桶 + median/MAD） |
| `arbitrage/execution/` | 双腿下单、PnL |
| `cex/` | Binance PM + Gate 适配器 |

## 运行

```bash
npm install
npm run start:dry
npm run start:dry -- --symbols BTCUSDT,ETHUSDT
npm run start:live -- --symbols BTCUSDT
```

启动后打开 **http://localhost:3456**（端口见 `config.json` → `dashboard.port`）查看实时卡片、收集进度与成交日志。

最小下单量/精度配置：`config/min-order-qty.json`（与 `config.json` 中 `strategy.symbols` 对应）。

**按共有币种批量生成**（推荐，与 collector 相同排序规则）：

```bash
npm run build:symbols-min-qty           # 全部共有币种
npm run build:symbols-min-qty -- --top 52   # 仅 top 52
```

输出 `config/symbols_config.json` + `config/min-order-qty.json`。

**仅更新 config.json 里已有 symbol 的精度**：

```bash
npm run fetch:min-qty
# 或 npm run fetch:min-qty -- --symbols SOLUSDT
```

逻辑文档：`../../exportAndBackTest/cex_cex_arbitrage_demo_logic.md`

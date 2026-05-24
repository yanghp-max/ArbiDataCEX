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
npm run build:dashboard   # 构建 Vue3 dashboard（dry/live 会自动构建）
npm run dry               # 虚拟盘（模拟下单，默认）
npm run live              # 实盘（真实下单）
```

Dashboard 前端源码在 `dashboard/frontend/`（Vue 3 + Vite），构建产物输出到 `dashboard/public/`。

开发时可单独跑前端热更新（需后端已启动提供 WS）：

```bash
npm run dev:dashboard
```

交易币种从配置文件自动读取，无需命令行指定：
- `config/symbols_config.json` → `selected_symbols`（币种白名单 + 流动性）
- `config/min-order-qty.json` → 精度配置
- 启动时取两者交集

启动后打开 **http://localhost:3456**（端口见 `config.json` → `dashboard.port`）查看实时卡片、收集进度与成交日志。

**按共有币种批量生成配置**（推荐，与 collector 相同排序规则）：

```bash
npm run build:symbols-min-qty           # 全部共有币种
npm run build:symbols-min-qty -- --top 52   # 仅 top 52
```

输出 `config/symbols_config.json` + `config/min-order-qty.json`。

**仅刷新已有币种的精度**（同样从配置文件读取币种列表）：

```bash
npm run fetch:min-qty
```

逻辑文档：`../../exportAndBackTest/cex_cex_arbitrage_demo_logic.md`

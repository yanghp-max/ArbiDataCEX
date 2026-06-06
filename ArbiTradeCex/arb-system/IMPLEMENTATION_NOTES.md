# ArbiTradeCex 实现记录

本文档记录相对初始 CEX-CEX 版本、参考 [ArbiTrade-1](../ArbiTrade-1) 与 `exportAndBackTest/cex_cex_arbitrage_demo_logic.md` 后，在 `arb-system` 内已完成的主要实现与修复。

---

## 1. 滚动窗口 `windowReady`（对齐 ArbiTrade-1）

**问题**：原实现用 `last.ts - first.ts`（毫秒）判断就绪，每 200ms 重算，导致进度在 99.9%↔100% 来回闪；就绪掉回 `false` 时 median/z-score 中断，交易判断被跳过。

**实现**（`arbitrage/calculator/rolling-signal-engine.js`）：

| 项目 | 改前 | 改后 |
|------|------|------|
| 就绪判断 | 每 tick 重算 | **锁存**：首次 `true` 后永久为 `true` |
| 时间跨度 | 毫秒差 `timeSpanMs` | 秒桶 `max(bucket) - min(bucket) + 1` |
| 过期桶 | `k < bk - windowSeconds` | `k < currentSecond - windowSeconds`（与 DataManager 一致） |

**效果**：warmup 到 100% 后进度与信号稳定；median/MAD/z 持续参与判断。

---

## 2. Dashboard 内存 OOM 与推送架构

**问题**：47 个 symbol、200ms tick 下，每个 symbol 更新都全量 `JSON.stringify(state)` 并 WebSocket 推送（约 235 次/秒）。运行约 17 分钟后 Node 堆涨至 ~3.2GB 触发 OOM。

**参考**：ArbiTrade-1 使用 Redis 解耦 + 防抖（`syncDebounceMs: 100`）+ 定频推送（价格 1s、账户 2s），不做「每 symbol 每 tick 全量 WS」。

**实现**：

### 2.1 分频道、定频、增量推送

**文件**：`arbitrage/dashboard/dashboard-bridge.js`、`dashboard/frontend/src/composables/useDashboardWs.js`

| 消息类型 | 触发 | 内容 |
|----------|------|------|
| `snapshot` | 新客户端连接 | 全量状态（仅一次） |
| `market:update` | 定频（默认 1s） | 本周期有变化的 symbol + 对应 progress |
| `trades:update` | 成交时 | 单笔 `trade` + `summary` |
| `logs:update` | 定频（默认 1s） | 新增日志条目 |
| `account:update` | 刷新/设基准 | `account` + `accountBaseline` |

策略 tick 只更新内存并标记 dirty，由定时器合并推送。

### 2.2 防护

- 无 WebSocket 客户端 → 不序列化、不发送（`dashboard-server.js` `hasClients()`）
- 慢客户端 `bufferedAmount > 2MB` → 跳过该连接，避免 `ws` 内部队列膨胀
- `ResultReporter.trades` 上限 500 条
- Binance/Gate 去掉重复的 `ticker` 双 emit；行情 handler 不再多余 spread 对象

### 2.3 配置

```json
"dashboard": {
  "enabled": true,
  "port": 3456,
  "broadcastIntervalMs": 1000
}
```

修改前端后需执行：`npm run build:dashboard`（`npm run dry` / `live` 会自动 build）。

---

## 3. 开仓最小量守卫与两腿数量对齐（防单腿）

**问题**：

1. `clipQty` 后数量可能低于交易所最小量，或 Gate `gateSize` 未重算，存在单腿风险。
2. 旧逻辑对 Gate 张数合约用 **floor**，且未强制 `binance.minQty`（JSON），导致如 BTWUSDT：Binance 最少 122、Gate 1 张=100，实际下 100 → 仅 Gate 成交。

**实现**（`common/utils/cross-exchange-order-qty.js`）：

| 规则 | 说明 |
|------|------|
| 币安下限 | `max(按 orderUsd 换算, JSON 中 binance.minQty)` |
| Gate 张数倍 | `gateBaseUnit = quantoMultiplier × gate.stepSize`（例：100 或 10） |
| 开仓对齐 | **向上** `ceil` 到 `gateBaseUnit` 整数倍（122 + 倍数 10 → 130；122 + 倍数 100 → 200） |
| 平仓对齐 | **向下** `floor`，避免超平 |
| 入口 | `resolveMinHedgeQty`、`finalizeOpenOrder(round:'ceil')`、`alignHedgeFromBaseQty(round:'floor')` |

**其它**：

- `cex/adapters/binance-adapter.js`：下单量按 `stepSize` 格式化；API 错误中文提示；双向持仓自动带 `positionSide`
- `arbitrage/execution/order-executor.js`：单腿仍成交时记录成交 + `[实盘·单腿风险]` 日志（不自动平仓）

**配置来源**：`config/min-order-qty.json` 为脚本生成**快照**，见 §11「未实现」。

---

## 4. Gate 单币种模式

**背景**：Gate 统一账户需约 500U 升级门槛；单币种永续账户可用 ~150U 运行。

**实现**：

- `config.json`：`"gateAccountMode": "single"`
- `cex/adapters/gate-adapter.js`：single 使用 `/futures/usdt/accounts`、`futures.balances` WS、`/wallet/user_id`；unified 路径保留
- `cex/manager.js` 传入 `gateAccountMode`

---

## 5. Dashboard 总 U 显示修复

**问题**：Gate `total=0`、`available=150` 时，`??` 无法回退，总 U 显示为 0。

**实现**：

- `gate-adapter.js` `#getSingleFuturesBalance`：`total <= 0` 时用 `available`
- `arbitrage/services/account-snapshot.js`：`resolveWalletUsdt` 使用 `Math.max(total, available)`

---

## 6. 进程生命周期日志

**文件**：`common/monitoring/process-lifecycle.js`

- 默认静默；仅在异常退出（未清除 run marker、非 0 退出码等）时控制台告警 `PREVIOUS_RUN_ABNORMAL`
- 使用 `logs/process-running.json` 标记运行中
- 可选 `processHealthHeartbeat: true` 写入心跳 JSONL

---

## 7. 已撤销

| 项 | 说明 |
|----|------|
| 一键平仓（position drain） | 按需求回退；仅保留信号驱动的开/平仓 |
| 实盘逐步跳过日志（预热/z/预占等） | 曾加过 `[实盘·跳过]` 逐步中文日志，后按需求删除；仅保留单腿成交记录与 `[实盘·单腿风险]` |

---

## 11. 未实现（有意暂不做的能力）

以下在讨论或 demo 文档中出现过，**当前代码未做**；需要时再排期。

### 11.1 最小下单量配置自动刷新

**现状**：

- `config/min-order-qty.json`、`config/symbols_config.json` 由 `npm run build:symbols-min-qty` 从 Binance/Gate REST **离线生成**（见 `scripts/build-common-min-order-qty.js`）。
- 策略**启动时读 JSON**，运行中**不会**再拉 `exchangeInfo` / Gate `contracts`。
- 文件头有 `generatedAt`；各币 `priceRef` 为生成时 bid/ask，仅用于写入当时的 `minNotional → minQty`。

**交易所会变**：`minQty`、`stepSize`、`minNotional`、Gate `quanto_multiplier`、`enable_decimal`、上下架等。

**未实现**：

- 启动时或定时（如每日）自动重建/增量更新 `min-order-qty.json`
- 运行时按 symbol 实时查交易所规则再下单
- 规则变更告警（JSON 年龄 / 与 API  diff）

**临时运维**：规则疑变、拒单、上新币后，在 ECS 手动执行 `npm run build:symbols-min-qty` 并重启 `npm run live`。

### 11.2 买一 / 卖一数量（盘口深度）

**现状**：

- 公共 WS 只解析 **bid/ask 价格**；`QuoteAggregator` tick 无 `bidQty`/`askQty`。
- 下单量由 `orderUsd` + JSON 精度规则 + 仓位上限决定；**不**限制在「当前一档可成交量」内。
- 发 **市价单**；一档不够时会吃多档（滑点），信号/PnL 仍按一档价估算。

**未实现**：

- WS 解析 Binance `B`/`A`、Gate book_ticker 量字段
- 下单前 `qty ≤ min(本腿要吃的一侧一档量)` 或按深度裁剪
- 深度不足时跳过或拆单

### 11.3 单腿成交自动补偿

**现状**：一腿成、一腿败时记录成交并打 `[实盘·单腿风险]`，**不**自动撤单/反向平敞口/重试失败腿。

**未实现**（demo 文档曾写过、后简化掉）：

- 失败腿重试、`max_order_retry`
- 已成交腿按盘口反向平仓
- 单腿时暂停该 symbol 直至人工处理

### 11.4 其它架构项

| 项 | 说明 |
|----|------|
| Dashboard 独立进程 + Redis | 未做；同进程 + 分频道推送已缓解 OOM |
| `RollingSignalEngine` median raw/adj 混用 | 历史备注，未改 |

---

## 8. 关键文件索引

| 模块 | 路径 |
|------|------|
| 滚动信号 | `arbitrage/calculator/rolling-signal-engine.js` |
| 策略任务 | `arbitrage/task-manager/cex-cex-task.js` |
| Dashboard 桥 | `arbitrage/dashboard/dashboard-bridge.js` |
| Dashboard 服务 | `arbitrage/dashboard/dashboard-server.js` |
| 前端 WS | `dashboard/frontend/src/composables/useDashboardWs.js` |
| Gate 适配器 | `cex/adapters/gate-adapter.js` |
| 账户快照 | `arbitrage/services/account-snapshot.js` |
| 最小量工具 | `common/utils/cross-exchange-order-qty.js` |
| 进程监控 | `common/monitoring/process-lifecycle.js` |
| 全局配置 | `config.json`、`config/global-config.js` |

---

## 9. 策略触发：WS 来价驱动（对齐 ArbiTrade-1）

**改前**：每 200ms 扫一遍全部 symbol（定频轮询）。

**改后**（`arbitrage/task-manager/index.js`）：

- Binance / Gate 任意一腿 `bookTicker` 更新 → 写 `QuoteAggregator` → **立即触发该 symbol 的 `onTick`**
- 对齐 ArbiTrade-1 `priceUpdateMode: 'any'`（任意端更新即算）
- 同一 symbol、同一事件循环内多次 WS 合并为 **一次** `onTick`（`setImmediate` 合并，非 200ms 定频）
- 仅保留 1s 定时器做 `reservationManager.purgeExpired()` 维护

滚动窗口仍按 **1 秒桶** 入窗；桶内高频 tick 覆盖写入，与 demo 文档一致。

---

## 10. 运行与运维提示

```bash
# 本地 dry-run（含 mock 账户 + Dashboard）
npm run dry

# 实盘（须 useMockAccount=false 且配置 .env API）
npm run live
```

- **Binance**：统一账户 PM + papi；API 需读取 + 统一账户交易 + IP 白名单
- **Gate**：单币种模式；永续读写 + 钱包只读；资金在 Web UI 设资金密码（不在 `.env`）
- **ECS 不看 Dashboard**：可设 `"dashboard": { "enabled": false }` 进一步省内存
- **OOM 排查**：`logs/last-exit.json`、`logs/process-health.jsonl`；Linux 上可查 `dmesg` OOM

---

*文档版本：2026-06-06，含两腿数量 ceil 对齐、单腿记录，及 §11 未实现清单。*

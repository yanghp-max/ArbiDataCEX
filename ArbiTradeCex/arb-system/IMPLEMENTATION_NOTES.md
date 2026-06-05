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

## 3. 开仓最小量守卫（防单腿）

**问题**：`clipQty` 后数量可能低于交易所最小量，或 Gate `gateSize` 未重算，存在单腿风险。

**实现**：

- `common/utils/cross-exchange-order-qty.js` — `resolveHedgeQtyFromBaseQty`
- `arbitrage/risk/risk-manager.js` — `alignHedgeFromBaseQty`、`finalizeOpenOrder`
- `arbitrage/task-manager/cex-cex-task.js` — 开仓走 `finalizeOpenOrder`；平仓对齐 `gateSize`；不满足时发 `MIN_QTY_SKIP`

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

## 7. 已撤销 / 未实现

| 项 | 说明 |
|----|------|
| 一键平仓（position drain） | 按需求回退；仅保留信号驱动的开/平仓 |
| Dashboard 独立进程 + Redis | 未做；当前同进程 + 分频道已缓解 OOM |
| `RollingSignalEngine` median 用 raw/adj 混用 | 历史备注，未改 |

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

*文档版本：2026-05-24，对应 Dashboard v5 channels 与 `windowReady` 锁存实现。*

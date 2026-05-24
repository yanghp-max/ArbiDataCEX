# CEX-CEX 套利简易实盘 Demo 实现逻辑

本文档整理一版 CEX-CEX 套利简易实盘 Demo 的实现逻辑。目标是把策略从实时行情监听，到信号计算、风控检查、双腿同时下单和结果记录，按实际执行顺序说明清楚。账户仓位与可用 USDT 以交易所 WS 缓存为准。

默认交易所映射：

```text
A = Binance（Portfolio Margin 统一账户，U 本位永续）
B = Gate（统一账户，U 本位永续）
```

**开发文档（实现细节以官方为准）：**

- Binance 统一账户（Portfolio Margin）：[https://developers.binance.com/docs/derivatives/portfolio-margin/general-info](https://developers.binance.com/docs/derivatives/portfolio-margin/general-info)
- Binance USDT 永续（公共行情 / 交易规则仍走 fapi）：[https://developers.binance.com/docs/derivatives/usds-margined-futures/general-info](https://developers.binance.com/docs/derivatives/usds-margined-futures/general-info)
- Gate 统一账户 WebSocket：[https://www.gate.com/docs/developers/unified/ws/en/](https://www.gate.com/docs/developers/unified/ws/en/)
- Gate REST API v4：[https://www.gate.com/docs/developers/apiv4/zh_CN/](https://www.gate.com/docs/developers/apiv4/zh_CN/)
- Gate 永续 WebSocket（公共盘口 + 合约仓位）：[https://www.gate.com/docs/developers/futures/ws/zh_CN/](https://www.gate.com/docs/developers/futures/ws/zh_CN/)

**Binance 双 REST 基址（与参考项目一致）：**

```text
fapi.binance.com  → 公共行情 WS、exchangeInfo、funding、bookTicker（不含账户/下单）
papi.binance.com  → listenKey、余额、仓位、U 本位永续下单（/papi/v1/um/*）
```

**Gate 统一账户 API 分工：**

```text
api.gateio.ws                    → REST /unified/accounts（余额）、/futures/usdt/positions、/futures/usdt/orders、contracts
wss://fx-ws.gateio.ws/v4/ws/usdt → 公共 futures.book_ticker + 私有 futures.positions（auth 签名）
wss://ws.gate.com/v4/ws/unified  → 私有 unified.asset_detail（USDT 可用余额，auth 签名）
```

下文 A/B 业务逻辑尽量对称；**仅 Gate 与 Binance 不同的部分** 见下表，其余按同一套流程实现即可。


| 项目           | Binance (A)                    | Gate (B)                                  |
| ------------ | ------------------------------ | ----------------------------------------- |
| 账户模式         | **Portfolio Margin 统一账户**      | **统一账户**（须开启 USDT 永续；如 `portfolio` / `multi_currency`） |
| 公共 WS        | `wss://fstream.binance.com/ws` + `bookTicker` | `wss://fx-ws.gateio.ws/v4/ws/usdt` + `futures.book_ticker` |
| 私有 WS（余额）    | `POST /papi/v1/listenKey` → `wss://fstream.binance.com/pm/ws/{listenKey}` | `wss://ws.gate.com/v4/ws/unified` + `unified.asset_detail`（auth） |
| 私有 WS（仓位）    | 同上，`ACCOUNT_UPDATE` 含仓位        | 同上 fx-ws 连接 + `futures.positions`（auth） |
| 私有频道         | `ACCOUNT_UPDATE`（余额+仓位）        | 余额：`unified.asset_detail`；仓位：`futures.positions` |
| 心跳           | 协议层 ping → pong                | fx-ws：协议层 ping/pong + 可选 `futures.ping`；unified WS：`unified.ping` |
| listenKey 续期 | 需要（`PUT /papi/v1/listenKey`，建议 60 分钟） | 不需要                                       |
| 合约名          | `BTCUSDT`                      | `BTC_USDT`（内部统一用 Binance 格式，对接 Gate 时做映射） |
| 可用 USDT      | WS `availableBalance` / `cw`；REST `GET /papi/v1/balance` | WS `unified.asset_detail` → `dts.USDT.a`；REST `GET /unified/accounts` |
| 净仓位          | `pa`（带符号）                      | `size`（带符号，`futures.positions`）           |
| 交易规则         | `GET /fapi/v1/exchangeInfo`（fapi） | `GET /futures/usdt/contracts`             |
| 下单           | `POST /papi/v1/um/order`       | `POST /futures/usdt/orders`（统一账户下仍走永续下单接口） |
| REST 刷新      | `GET /papi/v1/balance` + `GET /papi/v1/um/positionRisk` | `GET /unified/accounts` + `GET /futures/usdt/positions` |
| 持仓模式         | 单向净持仓                          | `position_mode = single`（单向净持仓）           |


## 1. 整体执行顺序

**第一版默认：单账户（单钱包）多币种 + 余额/仓位预占，无队列**（详见 **§7.5**）。Binance / Gate 各一套 USDT 池，所有 symbol 共用；**允许多笔 in-flight**，靠 **预占** 防超额；**有余额就 try，没有就 skip**，不排队、不讲究先后。

**程序启动时** 先按第 3 章建立 A/B WebSocket；**每条私有 WS 在 onOpen 里 REST 拉全量余额/持仓**（WS 不推首次快照），再进入 tick 循环。

每个 tick 到来后（**按 symbol 独立更新信号**），按下面顺序处理：

1. 接收该 symbol 的 A/B 盘口和资金费率。
2. 检查行情新鲜度。
3. 根据 `bid/ask` 计算两个方向的 spread。
4. 计算扣成本后的 spread。
5. 按秒入桶更新 **该 symbol** 滚动窗口，计算 `median`、`MAD`、`z-score`（每秒只保留 1 个 spread 样本）。
6. 做 **该 symbol** 信号层检查：warmup、z-score、funding、价差范围、`cooldown_ms`（per-symbol）。
7. 用 **最新 tick** 算 `qty`，**立即 try_reserve**（§7.5、§10.5）：够 → 异步发单；不够 → **skip**（`RESERVE_FAILED`），看下一个 symbol 的 tick。
8. 信号从产生到开跑：`now − tick.timestamp ≤ signal_max_age_ms`（默认 50ms），否则 **skip**（`SIGNAL_STALE`）。
9. 预占成功 → 第 8–11 章重检 + 第 12 章发单（可与其它 symbol **并行**）。
10. REST 回执 → 记 PnL → **release 预占**；WS 更新 cache。

## 2. 输入数据

本节只定义 **tick 里要有哪些字段**；数据从哪来、怎么连 WS，见 **第 3 章**。公共 WS 推送盘口后，在内存里拼成下面这一结构（一个 symbol 一条 tick，不是每个字段一条 WS）。

每个 tick 至少需要：

- `timestamp`：交易所行情时间戳，毫秒。
- `symbol`：交易对，例如 `BTCUSDT`。
- `a_bid` / `a_ask`：A 交易所买一 / 卖一。
- `b_bid` / `b_ask`：B 交易所买一 / 卖一。
- `funding_a` / `funding_b`：两边资金费率，可使用最近一次缓存值（可 REST 定时拉，或公共 WS 上另订阅 funding 相关频道，**与盘口共用同一条公共 WS**）。

程序收到 tick 后，记录本地接收时间，计算行情新鲜度：

```text
price_age_ms = now_ms - timestamp
```

如果：

```text
price_age_ms > max_price_age_ms
```

说明行情太旧，本 tick 不参与交易。

## 3. WebSocket 连接与数据流

Demo 通过 WebSocket 收 **盘口** 和 **账户变动**。实现时按下面规则组织即可。

### 3.1 连接数量

**不要每个 symbol、每个数据项各开一条 WS。**

| 交易所 | 连接 | 干什么 |
|--------|------|--------|
| **Binance** | 公共 WS ×1 | `bookTicker` |
| **Binance** | 私有 WS ×1 | `pm/ws/{listenKey}` → 余额 + 仓位 |
| **Gate** | 公共/私有 fx-ws ×1 | 公共 `futures.book_ticker` + 私有 `futures.positions`（同地址，auth 订阅仓位） |
| **Gate** | 统一账户 WS ×1 | `unified.asset_detail` → USDT 余额 |

跑 A + B 两家 → 一共 **最多 5 条连接**（Binance 2 + Gate 3）。Gate 的 fx-ws 上公共盘口与私有仓位可共用一条连接；余额走单独的 unified WS。

### 3.2 启动顺序

```text
1. 建立 A/B 公共 WS，连上后批量订阅所有 symbol 盘口
2. 建立 A/B 私有 WS（Binance：listenKey → pm/ws；Gate：unified.asset_detail + fx-ws futures.positions）
3. 公共、私有 WS 处理 ping → pong
4. 【关键】每条私有 WS 在 onOpen 回调里立刻 REST 拉全量余额 + 全量持仓，写入 cache（WS 不会推首次快照，见 3.4）
5. 标记 cache.reliable = true，启动 funding REST 定时拉取
6. 进入第 1 章 tick 循环
```

**不要** 等私有 WS 订阅成功后的第一条推送来初始化账户——那条推送可能永远不来（账户无变动时）。

### 3.3 公共 WS：盘口 → 第 2 章 tick

**订阅：**

- 维护「已订阅 symbol 列表」和 `activeSubscriptions`（断线重连后按此列表 **重新订阅**）
- **Binance**（订阅队列 + 限速，避免触发 5–10 msg/s 限频）：
  1. `subscribe(symbols)` 把每个 symbol 入队，去重；延迟约 **100ms**（队列 ≥10）或 **500ms**（队列 <10）后统一处理
  2. 待订阅数 **≥ 10**：**Combined Stream** — 收集全部 `{symbol}@bookTicker`，一条 `SUBSCRIBE` 最多 **200** 个 stream；超过 200 时分多条，条间等待 **500ms**
  3. 待订阅数 **< 10**：**标准批量** — 每批最多 **5** 个 symbol，合并成一条 `SUBSCRIBE`；批与批之间等待 **1200ms + 0–600ms 随机抖动**
  4. WS 未就绪时把 `SUBSCRIBE` 放入消息队列，连上后再发
- **Gate**：同一条 WS 发一条订阅，`channel: futures.book_ticker`，`payload` 为 **全部合约名数组**（如 `["BTC_USDT","ETH_USDT",…]`），不要每个合约各发一条
- 断线重连后，按保存的列表 **重新订阅一遍**

**收消息：**

```text
收到 WS 推送
  → 解析 symbol、bid、ask、时间戳
  → 更新内存：quoteCache[symbol].a 或 .b  （A 边 / B 边）

当某 symbol 的 A、B 两边 bid/ask 都有：
  → 拼成第 2 章 tick（a_bid, a_ask, b_bid, b_ask, funding_a, funding_b, timestamp）
  → 交给信号计算
```

Funding 若用 REST 定时拉，写入同一 `quoteCache` 或单独 `fundingCache`，拼 tick 时读即可。

### 3.4 私有 WS：账户 → 第 9/10 章缓存

**重要：余额 / 仓位 WS 只推「变更」，不推全量快照。**（与参考项目 BinanceAdapter 行为一致：注释为「WebSocket 只推送变化，不推送初始状态」。）

```text
- 订阅成功、刚连上 WS 时：不会收到完整账户列表
- 之后只有余额或仓位发生变化时，才推送一条消息
- 每条消息通常只带「本次变动」涉及的币种 / 合约（不是全账户状态）
```

#### 3.4.1 私有 WS 连上后：必须 REST 补全（参考项目做法）

Binance / Gate **私有 WS `onOpen` 里各执行一次**（顺序建议：先仓位后余额，或并行）：

| 交易所 | REST 全量（初始化 cache） |
|--------|---------------------------|
| Binance | `GET /papi/v1/um/positionRisk` → 遍历写入 `positionCache`；`GET /papi/v1/balance` → 写入 `balanceCache` |
| Gate | `GET /futures/usdt/positions` → 写入 `positionCache`；`GET /unified/accounts` → 解析 USDT `available` 写入 `balanceCache` |

```text
privateWs.onOpen():
  positions = REST_get_all_positions()
  for each p in positions:
    if abs(p.size) > 0: positionCache[exchange:symbol] = p
    else: delete positionCache[exchange:symbol]   // 0 仓不保留

  balances = REST_get_usdt_balance()
  balanceCache[exchange:USDT] = { available, updatedAtMs }

  wsConnected = true
  cache.reliable = true
  // 此后才依赖 WS 增量
```

**发单前**若 `cache.reliable = false` 或 `updatedAtMs` 过旧，仍走第 11 章 REST 刷新，不能假设 WS 已补过。

#### 3.4.2 WS 增量 merge 规则

1. **收到 WS 推送**：只对消息里出现的键 **merge**；未出现的 symbol / 币种 **保持 cache 原值**。
2. **余额 / 仓位变为 0**：从 cache **删除**该键（参考项目：`balanceCache.delete` / `positionCache.delete`），不要留 stale 非零值。
3. **禁止** 成交后本地 `pos ± qty`；等 WS 变更或 REST 刷新。

**Binance（统一账户）：**

```text
REST POST https://papi.binance.com/papi/v1/listenKey
连接 wss://fstream.binance.com/pm/ws/{listenKey}
每 listenkey_keepalive_min 分钟 PUT /papi/v1/listenKey 续期

推送 ACCOUNT_UPDATE 时（**仅含本次变动的资产**，`a.B[]` / `a.P[]` 可能只有部分条目）：
  对 a.B[] 每条：wb/cw → merge balanceCache[binance:currency]；wb=0 → delete
  对 a.P[] 每条：pa → merge positionCache[binance:symbol]；pa=0（平仓）→ delete
  未出现在本条 a.P[] / a.B[] 里的键 → cache 不变
```

**说明：** 公共盘口仍连 `wss://fstream.binance.com/ws`（fapi 侧）；只有私有账户流走 `/pm/ws/`。

**Gate（统一账户）：**

```text
余额 WS：
  连接 wss://ws.gate.com/v4/ws/unified
  订阅 channel: unified.asset_detail，payload: ["USDT"] 或 ["!all"]
  鉴权：报文内 auth（method=api_key, KEY, SIGN），签名串 channel=&event=&time=
  推送 update（**仅余额变化时**）→ merge balanceCache["gate:USDT"]；available=0 → delete

仓位 WS（与公共盘口共用 fx-ws 连接）：
  连接 wss://fx-ws.gateio.ws/v4/ws/usdt
  订阅 channel: futures.positions，payload: [user_id, "BTC_USDT", ...] 或按 Gate 文档批量订阅
  同样带 auth 签名
  推送 update（**仅该合约仓位变化时**）→ merge positionCache["gate:BTCUSDT"]；size=0 → delete；其他合约 cache 不变
```

**说明：** 统一账户下 **不要** 再用 `futures.balances` 读余额，改走 `unified.asset_detail`；仓位仍走 `futures.positions`。

**断线时：** **不要清空** `balanceCache` / `positionCache`（参考项目断线也不 clear，避免重连风暴打 REST）。设 `wsConnected = false`、`cache.reliable = false`。重连私有 WS 的 `onOpen` 里 **再 REST 全量补一次**（同 3.4.1），然后 WS 继续增量 merge。

### 3.5 心跳与 listenKey

- **公共 + 私有 WS**：收到协议层 **ping** 必须立刻 **pong**（连接状态为 OPEN，payload 与 ping 一致）
- **Binance 私有**：定时 `PUT /papi/v1/listenKey` 续期；收到 `listenKeyExpired` → 新建 listenKey → 重连 `pm/ws` → REST 再同步账户
- **Gate fx-ws**：协议层 ping/pong + 可选 `futures.ping`
- **Gate unified WS**：协议层 ping/pong + 可选 `unified.ping`
- **Gate**：无 listenKey
- Binance 连接约 **24 小时**会过期，可在接近 24h 时主动断开重连

### 3.6 断线重连

```text
1. 标记 wsConnected = false，cache.reliable = false（不清空 cache）
2. 等待 ws_reconnect_base_ms，指数退避，上限 ws_reconnect_max_ms
3. 重新建立 WS；Binance 检查 listenKey，过期则新建
4. 重新订阅（公共盘口 / Gate 仓位 / Gate unified 余额 / Binance 私有）
5. 私有 WS onOpen → REST 全量补余额 + 持仓（3.4.1），再设 cache.reliable = true
6. wsConnected = true
```

重连期间盘口 tick 仍可用旧 quote；**发单前**若账户 cache 不可靠或过期，必须第 11 章 REST。

### 3.7 缓存年龄（供第 11 章）

每次写入 `balanceCache` / `positionCache` 时记录 `updatedAtMs`（毫秒时间戳）。

```text
cache_age_ms = now_ms - updatedAtMs

若 cache_age_ms > account_cache_max_age_ms，或 wsConnected = false：
  → 第 11.1 用 REST 刷新余额后再发单
```

### 3.8 建议模块划分

| 模块 | 职责 |
|------|------|
| `ExchangeWsClient`（A/B 各一或各二：public/private） | 连 WS、订阅、ping/pong、重连、解析原始消息 |
| `QuoteAggregator` | 合并 A/B 盘口与 funding → 第 2 章 tick |
| `AccountCache` | 维护 balanceCache、positionCache、updatedAtMs、reliable；私有 WS onOpen REST 初始化 + WS 增量 merge（见 **3.4**） |
| `ReservationManager` | `try_reserve` / `release` / TTL；**mutex 或同步临界区**，禁止并发改同一 `binance:USDT` / `gate:USDT`（§7.5.3.2） |

每个交易所的差异（频道名、listenKey、auth）集中在 `ExchangeWsClient` 的实现分支或子类里，业务逻辑只读统一的 cache 和 tick 结构。

## 4. 参数配置

第一版使用单组参数：

```text
window_seconds = 3600
min_data_points = 50
z_open_ab = 2.0
z_open_ba = 2.0
order_usd = 100
max_position_usd = 2000
cooldown_ms = 1000
signal_max_age_ms = 50
reservation_ttl_ms = 30000
max_in_flight_trades = 5
symbols = ["BTCUSDT", "ETHUSDT"]   // 示例；CLI 或 symbols_config 加载
funding_min = -0.1
fee_bps_total = 4
slippage_bps_total = 4
max_price_age_ms = 1000
min_available_usdt = 50
balance_check_rate = 0.10
account_cache_max_age_ms = 5000
listenkey_keepalive_min = 60
ws_reconnect_base_ms = 1000
ws_reconnect_max_ms = 60000
ws_silent_timeout_ms = 300000
```

- `window_seconds`：滑动窗口长度（秒），默认 3600（1 小时）；窗口内最多保留这么多 **1 秒时间桶**。
- `min_data_points`：warmup 所需最少样本点数（按秒采样后的点数），默认 50。
- `min_available_usdt`：A/B 账户 `availableBalance` 的最低门槛，低于则不下单。
- `balance_check_rate`：本单所需 USDT 粗算系数，按 `qty × 成交价 × balance_check_rate` 估算（默认 0.10，约等于 10x 杠杆粗算）。
- `account_cache_max_age_ms`：账户 WS 缓存超过该年龄时，发单前必须 REST 刷新。
- `cooldown_ms`：**Per-symbol** 同一 symbol 两笔之间的最短间隔，默认 1000。
- `signal_max_age_ms`：信号 tick 的 `timestamp` 到 **开始 try_reserve** 不得超过该值，否则 skip，默认 **50ms**（替代排队超时；**无队列**）。
- `reservation_ttl_ms`：预占超时自动 `release`，默认 30000。
- `max_in_flight_trades`：全局 in-flight 上限，默认 5。
- `symbols`：本进程订阅并评估的 symbol 列表；共用一套 Binance / Gate 账户 USDT。
- `funding_min`：任一侧 funding 低于此值不生成机会。
- `listenkey_keepalive_min`：Binance 统一账户 `listenKey` 续期间隔（分钟），建议 **60**（与官方 Portfolio Margin 一致）。
- `ws_reconnect_base_ms` / `ws_reconnect_max_ms`：断线重连退避起止。
- `ws_silent_timeout_ms`：长时间无 WS 消息则主动重连。

数量换算约定：

```text
USD 名义金额统一使用 A 侧，也就是 Binance 侧价格换算成币数量。
```

成本口径：

```text
total_cost_pct = (fee_bps_total + slippage_bps_total) / 100
```

默认 `4 bps + 4 bps = 8 bps = 0.08%`。因为 spread 单位是百分比点，所以直接从 spread 中减 `0.08`。

## 5. 方向定义

### 5.1 `-a+b`

含义：A 侧开空，B 侧开多。

- A 使用 `a_bid` 卖出 / 开空。
- B 使用 `b_ask` 买入 / 开多。

spread 计算：

```text
spread_ab = (a_bid - b_ask) / b_ask * 100
```

当 A 的 bid 明显高于 B 的 ask，扣除成本后仍有空间时，触发该方向。

### 5.2 `+a-b`

含义：A 侧开多，B 侧开空。

- A 使用 `a_ask` 买入 / 开多。
- B 使用 `b_bid` 卖出 / 开空。

spread 计算：

```text
spread_ba = (b_bid - a_ask) / a_ask * 100
```

当 B 的 bid 明显高于 A 的 ask，扣除成本后仍有空间时，触发该方向。

## 6. 信号计算

### 6.1 计算原始 spread

实时监听只有两边盘口 `bid/ask`，spread 在程序内直接计算：

```text
spread_ab = (a_bid - b_ask) / b_ask * 100
spread_ba = (b_bid - a_ask) / a_ask * 100
```

### 6.2 计算扣成本 spread

```text
spread_ab_adj = spread_ab - total_cost_pct
spread_ba_adj = spread_ba - total_cost_pct
```

### 6.3 滚动窗口（按秒采样）

WS 推送频率远高于 1Hz，**不能每个 tick 都入窗**。按参考项目（DataManager 时间桶）做法：

```text
bucket_time = floor(timestamp_ms / 1000)
```

**入桶规则：**

- 每个 symbol 维护 `Map<bucket_time, {spread_ab, spread_ba}>`，桶数量 ≤ `window_seconds`
- 同一秒内收到多个 tick：**只保留该秒最后一个 spread**（覆盖写入），即 **每秒最多 1 个价格点**
- 进入新秒时，删除 `bucket_time < currentSecond - window_seconds` 的旧桶

**统计（对窗口内全部秒级样本，每桶 1 点）：**

```text
median_ab = median(各桶 spread_ab)
median_ba = median(各桶 spread_ba)
mad_ab = median(|spread_ab - median_ab|)
mad_ba = median(|spread_ba - median_ba|)
```

说明：

- `median` / `MAD` 用 **原始 spread**（不扣成本）；当前 z-score 用 **扣成本 spread**。
- 样本序列长度 ≈ 窗口内秒数（最多 `window_seconds`），与 WS tick 频率无关。
- 若 `mad_ab` 或 `mad_ba` 为 0，该方向 z-score 无效，本 tick 不交易。

**warmup 就绪**（参考项目 `isWindowReady`）：

```text
time_span = max(bucket_time) - min(bucket_time)   // 秒
window_ready = (time_span >= window_seconds) AND (样本点数 >= min_data_points)
```

就绪后 `window_ready` 保持 true，不再回退。

### 6.4 计算 z-score

```text
z_ab = (spread_ab_adj - median_ab) / mad_ab
z_ba = (spread_ba_adj - median_ba) / mad_ba
```

含义：

- `z_ab` 越大，表示 `-a+b` 当前扣成本价差相对滚动窗口中位数越异常。
- `z_ba` 越大，表示 `+a-b` 当前扣成本价差相对滚动窗口中位数越异常。

## 7. 信号层检查

这一层只判断“从策略角度看，现在有没有交易机会”。

每个 tick 按顺序检查：

1. `warmup`：该 symbol 的 `window_ready` 是否为 true（见 6.3）。
2. `z-score`：`z_ab` / `z_ba` 是否有效。
3. `funding`：任一侧 funding 为空或 `< funding_min`，不生成机会。
4. 方向阈值：至少一个方向满足开仓阈值。
5. 价差范围：扣成本后的 spread 必须在 `0% - 10%`。

**注意（多币种）：** 余额 / 预占不在本层；通过后 **本 tick 立即 try_reserve**（§7.5）。`cooldown_ms` 也在本层检查。

方向判断：

```text
can_open_ab = z_ab >= z_open_ab
can_open_ba = z_ba >= z_open_ba
```

如果两个方向都不满足，不交易。

如果两个方向同时满足，选择 z-score 更大的方向：

```text
direction = "-a+b" if z_ab >= z_ba else "+a-b"
```

选定方向后，取对应扣成本 spread：

```text
adj_spread = spread_ab_adj if direction == "-a+b" else spread_ba_adj
```

硬过滤：

```text
0.0 <= adj_spread <= 10.0
```

该过滤用于排除负收益空间、插针、宕机、脏数据或过大的异常价差。

通过 §7 全部检查后，**同一 tick 内** 进入 §7.5 try_reserve（**不入队**）。

## 7.5 单账户多币种与预占（drop-fast，无队列）

### 7.5.1 架构

```text
symbols[] ──► RollingSignalEngine[symbol] ──信号 OK──► try_reserve（本 tick）
                                                          │
ReservationManager ◄── balanceCache / positionCache       ├─ 够 → 异步 execute
  usdtReservations[]                                      └─ 不够 → skip
  positionReservations[exchange:symbol]
```

- **Per-symbol**：滚动窗口、z-score、`last_order_ts`、`cooldown_ms`。
- **Global**：USDT / 仓位预占、`in_flight_count`。
- **无 OpportunityQueue**：不 FIFO、不「谁先谁后」；**有 available 就成交，没有就跳过**。

### 7.5.2 本 tick 执行路径

```text
function on_signal_ready(tick, direction, signal):
  if now - tick.timestamp > signal_max_age_ms:
    return SKIP SIGNAL_STALE
  if now - state[tick.symbol].last_order_ts < cooldown_ms:
    return SKIP COOLDOWN
  if in_flight_count >= max_in_flight_trades:
    return SKIP MAX_IN_FLIGHT

  order = build_and_normalize_order(direction, tick)    // §8
  if order.qty <= 0:
    return SKIP

  reservations = try_reserve(tick.symbol, direction, order, tick)   // §7.5.3
  if not reservations:
    return SKIP RESERVE_FAILED          // 余额/仓位不够，直接跳过

  in_flight_count++
  execute_trade_async(tick.symbol, order, tick, reservations)
```

### 7.5.3 预占（对齐参考项目 SmartBalanceCache）

**原则：** `available = cache.total − Σ(active_reservations)`（同参考 `getAvailableBalance`）。

参考项目在 `WalletAllocator.allocateAndReserve` 里 **先算 available、再 reserve**；`reserveClosingCapacity` 注释为 **「原子性检查 + 预留」**——**读余额与写 `reservations` 不能拆开给两个并发 tick 插队**（见 `arb-system/arbitrage/cache/README.md` 的 `checkAndReserve`）。

#### 7.5.3.1 共享变量（多 symbol 抢同一池）

| 键 | 谁共用 |
|----|--------|
| `binance:USDT` | 所有 symbol 的 A 腿 USDT 预占 |
| `gate:USDT` | 所有 symbol 的 B 腿 USDT 预占 |
| `binance:BTCUSDT` / `gate:ETHUSDT` 等 | 各 symbol 仓位容量预占（§9.5） |

BTC、ETH 同时来信号时，都在改 **`binance:USDT` 的 Σ reserved**——**不能并发改**，但不是业务 FIFO 队列。

#### 7.5.3.2 原子 `try_reserve`（参考 checkAndReserve）

`ReservationManager.try_reserve` 必须是 **一段不可分割的临界区**：

```text
function try_reserve(symbol, direction, order, tick):
  // ① 进入临界区（见下）
  a_need, b_need = calc_usdt_need(direction, order.qty, tick)

  avail_a = get_available_usdt("binance")   // total − Σ reserved，含其它 symbol 已占
  avail_b = get_available_usdt("gate")
  if avail_a < max(min_available_usdt, a_need): return null
  if avail_b < max(min_available_usdt, b_need): return null
  if would_increase_abs_position(...) and not position_capacity_ok(...): return null

  // ② 同一临界区内一次性写入（A+B+仓位），禁止只写 Binance 解锁后再写 Gate
  ids = {
    bal_a: _reserve_usdt_locked("binance", a_need, trade_id),
    bal_b: _reserve_usdt_locked("gate", b_need, trade_id),
    pos:   _reserve_position_locked(...)    // 可选，§9.5
  }
  // ③ 离开临界区
  return ids
```

**实现要求（与参考项目等价）：**

1. **Node 第一版**：`try_reserve` **全程同步、内部不要 `await`**——单线程事件循环下，函数跑完前不会插入别的 tick，等价互斥。
2. **若以后在 reserve 路径里有 `await`**：必须为 `ReservationManager` 加 **`reservationMutex`**（短锁）；抢锁失败 **不等待重试**，直接 `RESERVE_FAILED` skip（drop-fast，与无业务队列一致）。
3. **禁止部分预占**：检查 Binance 够、已写 `bal_a` 后发现 Gate 不够 → **回滚已写 reservation**（参考 `allocateAndReserve` 失败时 `release(balanceReservationId)`），返回 `null`。
4. **`release`** 也应在同一 mutex 内更新 `reservations` / `positionReservations`（或同步函数）。

```text
get_available_usdt(exchange):
  total = balanceCache[exchange:USDT].total
  reserved = sum(reservations where type=balance and key=exchange:USDT)
  return total - reserved
```

- **不锁价格**；§11 发单前仍用最新 tick 重检 spread。
- **释放**：成交结束 / 失败 / skip / `reservation_ttl_ms` 超时 → `release(all)`（mutex 内）。

### 7.5.4 并行与「先后」

多 symbol 同时来信号时：

- 各自调用 `try_reserve`，但在 **mutex / 同步临界区** 内串行改 `reservations`——**不是机会排队**，只是 **不能同时改同一 USDT 余额**。
- 先进入临界区的 symbol 占掉 `a_need`；后到的看到 `available` 已减小，**够就占，不够就 `RESERVE_FAILED` skip**。
- 发单阶段仍可多笔 **in-flight**；互斥只包住 **try_reserve / release** 几行逻辑。

### 7.5.5 与参考项目

| 参考项目 | 本文 |
|---------|------|
| `getAvailableBalance`（total − reserved） | §10.1 |
| `checkAndReserve` / `allocateAndReserve` 原子预占 | §7.5.3.2 `try_reserve` 临界区 |
| `reserveClosingCapacity` 原子检查+预留 | §9.5 仓位容量预占 |
| `release` / 失败回滚 | §10.5 |
| WalletPool 排队 | **无**；drop-fast |
| SmartOpportunityQueue | **无** |

## 8. 数量计算与交易所精度

### 8.1 先按 `order_usd` 计算目标数量

无论交易方向是什么，`order_usd` 转 `qty` 都统一使用 A 侧价格。

`-a+b`：

```text
raw_qty = order_usd / a_bid
```

`+a-b`：

```text
raw_qty = order_usd / a_ask
```

### 8.2 再按两个交易所规则修正

实盘下单前必须读取并缓存两个交易所的交易规则：

- `minQty`：最小下单数量。
- `stepSize`：数量步进。
- `minNotional`：最小名义金额。
- `priceTickSize`：价格精度。只有使用限价单、或者需要自己传订单价格时才需要；如果第一版全部使用市价单，可以先不参与数量修正。

规则接口见文首 A/B 差异表（Binance `GET /fapi/v1/exchangeInfo` 仍在 **fapi**；Gate `contracts`）。

数量修正：先分别按 A/B 两边的数量精度向下取整，再取两边都能成交的较小数量。

```text
a_qty = floor_to_step(raw_qty, a_step_size)
b_qty = floor_to_step(raw_qty, b_step_size)
qty = min(a_qty, b_qty)
```

如果 `qty` 小于 A/B 任一侧的最小下单数量，本次不下单：

```text
qty < a_minQty || qty < b_minQty
```

或者任一边名义金额低于对应交易所的 `minNotional`，本次不下单。

`-a+b` 方向使用的成交参考价：

```text
a_notional = qty * a_bid
b_notional = qty * b_ask
```

`+a-b` 方向使用的成交参考价：

```text
a_notional = qty * a_ask
b_notional = qty * b_bid
```

只要任一侧低于对应交易所的最小名义金额，本次不下单：

```text
a_notional < a_minNotional || b_notional < b_minNotional
```

金额、数量、PnL 计算建议使用高精度 decimal / big number，不要直接依赖浮点数做最终下单数量。

## 9. 仓位上限检查（WS 仓位缓存）

**硬性要求：A/B 两边账户使用单向净持仓模式。** 每个 symbol 只有一个带符号净仓位；`-a+b` 与 `+a-b` 相互抵消，不实现单独「平仓」动作。

仓位数量 **不由程序手工加减**，以 **交易所 WS 推送的净仓位** 为准，本地只维护缓存并做上限检查。

### 9.0 方向如何相互抵消

同一 symbol 在每个交易所只有一个 **净仓位**（正=多，负=空）。`-a+b` 与 `+a-b` 是反向操作，成交后会减少或反转已有净敞口：


| 步骤                    | A 侧（Binance） | B 侧（Gate）   |
| --------------------- | ------------ | ----------- |
| 初始                    | `0`          | `0`         |
| `-a+b` 成交 `qty=0.01`  | `-0.01`（空）   | `+0.01`（多）  |
| `+a-b` 再成交 `qty=0.01` | `0`（空被买回抵消）  | `0`（多被卖出抵消） |


对应关系：

```text
-a+b：A 卖 qty、B 买 qty  →  A 更空 / B 更多
+a-b：A 买 qty、B 卖 qty  →  A 减空 / B 减多（与上一笔反向，净仓位回到 0 或减小）
```

10.3 的 `a_pos_after` / `b_pos_after` 公式基于上述净持仓规则。

**账户配置：** A/B 永续合约账户均设为 **单向净持仓**。下单使用默认参数即可，无需额外仓位方向字段。

### 9.1 账户 WS 与本地缓存

逻辑见 **第 3.4 节**（WS 只推变更、onOpen REST 全量、merge / 归零 delete）。本节只列 cache 键与读法。


| 缓存              | 键                 | 初始化来源 | WS 更新 |
| --------------- | ----------------- | ----- | ----- |
| `positionCache` | `exchange:symbol` | REST 全量持仓 | 仅变更合约 merge；size=0 则 delete |
| `balanceCache`  | `exchange:USDT`   | REST 全量余额 | 仅 USDT 变更 merge；available=0 则 delete |


**`cache.reliable`**：`onOpen` REST 成功后为 `true`；断线或 listenKey 失效为 `false`，发单前须 REST 刷新（第 11 章）。缓存年龄见 **3.7 节**。

### 9.2 读取当前仓位

发单前从 `positionCache` 读取 **带符号净仓位**：

```text
a_pos_before = positionCache["binance:BTCUSDT"]   // 例如 -0.01
b_pos_before = positionCache["gate:BTCUSDT"]      // 例如 +0.01
```

缓存无记录视为 `0`（通常说明 REST 初始同步尚未完成）。成交后 **不要** 本地 `a_pos ± qty`；等 WS 变更推送或 REST 刷新后 cache 自动对齐。

### 9.3 计算交易后仓位（还未交易，先判断如果交易之后，仓位的变化如何）

使用同一个 `qty`，按方向计算 **预估** 交易后仓位，用于上限检查：

`-a+b`：

```text
a_pos_after = a_pos_before - qty
b_pos_after = b_pos_before + qty
```

`+a-b`：

```text
a_pos_after = a_pos_before + qty
b_pos_after = b_pos_before - qty
```

### 9.4 最大仓位与截断

单腿最大仓位按当前 A 侧价格把 USD 上限转成数量。不同方向使用的 A 侧成交参考价不同：

`-a+b`：

```text
max_position_qty = max_position_usd / a_bid
```

`+a-b`：

```text
max_position_qty = max_position_usd / a_ask
```

检查：

```text
abs(a_pos_after) <= max_position_qty
abs(b_pos_after) <= max_position_qty
```

如果超过上限，可以先把本次 `qty` 截断到不超限的最大数量；截断后若低于 `minQty` 或 `minNotional`，本次不下单。

如果某一边已经达到或超过最大仓位：

- 下一笔若会让 **已到顶的一边继续变大** → 不交易。
- 下一笔若会让 **已到顶的一边变小**（反方向抵消）→ 允许，但仍需检查另一边是否超限。
- 可通过截断 `qty` 使 `abs(pos_after)` 不恶化；截断后仍有可交易数量则允许。

### 9.5 仓位容量预占（多币种并发）

并发时不能只看 `positionCache` 单点快照，需叠加 **已预占未释放** 的容量（对齐参考项目 `positionReservations`）：

```text
get_available_position_capacity(exchange, symbol) =
  max_position_qty
  − abs(positionCache[exchange:symbol] 或 0)
  − position_reserved[exchange:symbol]
```

`try_reserve` 时若本笔会 **增大** `abs(pos_after)`（相对 `pos_before`），则：

```text
position_reserved[exchange:symbol] += qty   // 两腿各预占一次，键分别为 binance:symbol / gate:symbol
```

若 `qty > get_available_position_capacity(...)` → 预占失败，不发起该笔。

反向抵消（`+a-b` 减小已有 `-a+b` 仓位）**不预占** 容量，但仍预占 USDT（§10.5）。

## 10. 余额检查与预占

发单前读 **扣预占后的可用 USDT**（对齐参考项目 `getAvailableBalance`）。**程序内必须预占**（§7.5.4），多笔并行靠 `available = total − reserved` 防超额。

真正提交订单时，**各交易所自己的下单接口会再验一次资**——够才接单，不够直接拒单。

```text
Binance：POST https://papi.binance.com/papi/v1/um/order
Gate：    POST /futures/usdt/orders
```

程序里可封装为 `submitOrder(exchange, ...)` 等；具体参数查文首开发文档。

### 10.1 余额数据来源

```text
total_balance[exchange]     = balanceCache[exchange:USDT].total   // 或 available + 已冻结，与 cache 字段一致
reserved_usdt[exchange]     = Σ usdtReservations where key == exchange:USDT and status == active
available_balance[exchange] = total_balance[exchange] − reserved_usdt[exchange]
```

WS 推送更新 `total_balance`；**预占只改程序内 `usdtReservations`**，不等 WS 再开下一笔。

### 10.2 本单所需 USDT（粗算）

与常见 CEX 发单前粗算方式一致，按名义金额乘以固定比例：

`-a+b`：

```text
a_need = qty * a_bid * balance_check_rate
b_need = qty * b_ask * balance_check_rate
```

`+a-b`：

```text
a_need = qty * a_ask * balance_check_rate
b_need = qty * b_bid * balance_check_rate
```

默认 `balance_check_rate = 0.10`（名义金额的 10%，约 10x 杠杆粗算）。

### 10.3 A/B 分别检查

```text
available_balance[A] >= max(min_available_usdt, a_need)
available_balance[B] >= max(min_available_usdt, b_need)
```

**任一侧 `available_balance`（扣预占后）不够 → 预占失败**，整笔不下单。

多 symbol 共用 USDT 池时，**第二笔读 `total − Σ reserved`**；**`try_reserve` 临界区** 保证不会两笔同时通过检查（对齐参考 `checkAndReserve`）。

### 10.4 与提交订单的关系

```text
① try_reserve：USDT + 仓位容量预占成功
② 第 11 章最终检查通过
③ 分别调用 A/B 下单 API
④ 交易所验资 → 成交或拒单
⑤ WS 更新 balanceCache / positionCache
⑥ finally：release 预占（无论成败）
```

### 10.5 预占生命周期

对外只暴露 **`try_reserve`（原子）** 与 **`release_all`**；内部 `reservations` Map 的读写均在 §7.5.3.2 临界区内。

```text
try_reserve(...) → { bal_a, bal_b, pos? } 或 null
  记录 { id, type, key, amount, created_at, trade_id, status: active }

release_all(ids)          // finally；mutex 内
purge_reservation_ttl()   // 定期 TTL 强制 release
```

**典型时序：**

```text
try_reserve（临界区）→ execute_both_legs → release_all（临界区）
```

失败回滚：临界区内 Gate 不足 → 释放本笔已写的 Binance 预占，返回 `null`。

## 11. 执行前最终检查

发单前最后一道确认，防止 **预占到发单之间** 盘口、spread 已变化。仓位已在 **预占 + 第 9 章** 约束；本章 **不重查仓位**。

### 11.1 REST 刷新（缓存偏旧时必做）

若 `balanceCache` 年龄 `> account_cache_max_age_ms`，或 WS 未连接：

```text
Binance: GET https://papi.binance.com/papi/v1/balance  +  GET /papi/v1/um/positionRisk
Gate:    GET https://api.gateio.ws/api/v4/unified/accounts  +  GET /futures/usdt/positions
```

用 REST 结果 **覆盖** 本地缓存。若执行了 REST 刷新，**仅重跑第 10 章余额检查**；仓位仍信任第 9 章结果，不在本章重算。

### 11.2 检查项

- 行情未过期：`price_age_ms <= max_price_age_ms`。
- spread：选定方向扣成本 spread 仍在 `0% - 10%`。
- 精度：`minQty`、`stepSize`、`minNotional` 仍满足。
- **若 10.1 触发了 REST 刷新**：用刷新后的 `available_balance` 重算第 10 章 `a_need` / `b_need`。

任一不满足 → 跳过本次交易，不下单。

## 12. 双腿同时下单

简易实盘假定 CEX 两腿订单都会成功，因此采用同时下单：

```text
同时发送 A 腿订单和 B 腿订单
等待两边 REST 下单回执（或必要时再查单）
从回执解析真实成交价 / 成交量 → 计算 net_pnl → 写 trade log
仓位与余额 cache 仍等 WS 变更推送（或 REST）更新，见第 3.4 节
```

### 12.1 从下单回执解析字段

市价单提交后，**以交易所返回的成交字段为准**，不要继续用发单前 tick 的 bid/ask 算 PnL。

| 统一字段 | Binance（`POST /papi/v1/um/order` 回执） | Gate（`POST /futures/usdt/orders` 回执） |
|---------|-------------------------------------------|----------------------------------------|
| `order_id` | `orderId` | `id` |
| `status` | `status`（如 `FILLED`） | `status`（如 `finished`） |
| `filled_qty` | `executedQty`（币数量） | `abs(size)` × `quanto_multiplier`（或查单里的成交量；Gate 以张数 `size` 下单时需换算） |
| `avg_price` | `avgPrice`（无则 `price`，或查 `/papi/v1/um/order`） | `fill_price`（无则再 `GET /futures/usdt/orders/{id}`） |

若回执里成交价/量不完整：**REST 查单一次**再解析，仍失败则记 `status=UNKNOWN`，本笔 `net_pnl` 不纳入累计（或标记待补）。

两腿都成功后，写入本笔成交结构：

```text
fill = {
  direction,
  a_order_id, b_order_id,
  a_filled_qty, b_filled_qty,
  a_price_used,   // Binance avgPrice
  b_price_used,   // Gate fill_price（换算后）
  qty = min(a_filled_qty, b_filled_qty)   // 对冲口径取较小值
}
```

### 12.2 记录与 PnL

```text
net_pnl = calc_trade_pnl(fill)          // 见第 13 章，用 a_price_used / b_price_used
cum_pnl += net_pnl
reporter.record_trade(fill, net_pnl, account_cache)
// state[symbol].last_order_ts 在 execute_trade finally 前更新；预占在 finally release
```

**注意：** `a_pos_qty` / `b_pos_qty` 写入日志时读 **WS 更新后的 positionCache**（或成交后 REST 查仓），不要用手工 `pos ± qty`。

## 13. PnL 计算

**输入必须来自第 12 章回执解析的 `a_price_used`、`b_price_used`、`qty`（= `min(a_filled_qty, b_filled_qty)`），不要用信号 tick 的 bid/ask。**

### 13.1 单笔开仓即时收益

`-a+b`（A 开空、B 开多）：

```text
gross_profit = qty * a_price_used - qty * b_price_used
a_leg_value  = qty * a_price_used
b_leg_value  = qty * b_price_used
```

`+a-b`（A 开多、B 开空）：

```text
gross_profit = qty * b_price_used - qty * a_price_used
a_leg_value  = qty * a_price_used
b_leg_value  = qty * b_price_used
```

手续费 / 滑点按两腿 **实际成交额** 分别计算：

```text
fee_rate_total = (fee_bps_total + slippage_bps_total) / 10000
fee_rate_per_leg = fee_rate_total / 2
fee_cost = abs(a_leg_value) * fee_rate_per_leg + abs(b_leg_value) * fee_rate_per_leg
net_pnl = gross_profit - fee_cost
```

### 13.2 累计

```text
cum_pnl = previous_cum_pnl + net_pnl
```

在净持仓下，`+a-b` 会抵消 `-a+b` 建立的仓位（见第 9.0 节）。没有单独「平仓」动作；每笔成交独立算 `net_pnl` 并累加。

如果需要主动退出，有以下几种方式：
1.使用点击停止之后监听到的最后一条数据的价差来强平。

## 14. 模块划分

建议拆成以下模块：

- `ExchangeWsClient`：A/B 各所的公共 + 私有 WS（订阅、ping/pong、listenKey 续期、断线重连、消息解析）。
- `QuoteAggregator`：合并 A/B 盘口与 funding，输出第 2 章 tick。
- `AccountCache`：维护 balanceCache / positionCache 及 updatedAtMs、reliable。
- `SpreadCalculator`：计算 `spread_ab` / `spread_ba` 和扣成本 spread。
- `RollingSignalEngine`：按 symbol 实例化；**1 秒时间桶** 滚动窗口 → `median`、`MAD`、`z_ab`、`z_ba`。
- `ReservationManager`：`try_reserve` / `release` / TTL；**mutex 同步临界区**（§7.5.3.2）。
- `RiskManager`：funding、价差范围、per-symbol `cooldown`；第 9 章仓位截断。
- `BalanceChecker`：读 **扣预占后** `available_balance`（§10.1）。
- `FinalChecker`：第 11 章 REST 刷新（必要时）+ spread/行情/精度最终校验；不重查仓位。
- `OrderExecutor`：向两个交易所同时发送订单，查询成交回报。
- `ExecutionStatusLogger`：记录状态流与耗时。
- `ResultReporter`：解析第 12 章 `fill` → 第 13 章 `net_pnl` → 写 trade log / 累计 `cum_pnl`（第 16 章字段）。

## 15. 主循环伪代码

**无队列：信号 OK → try_reserve → 够就发，不够就 skip。**

```text
reservationManager = new ReservationManager({ ttlMs: 30000 })
in_flight_count = 0

function on_tick(tick):
  if tick.price_age_ms > max_price_age_ms:
    return

  signal = rolling_engine[tick.symbol].update_and_calc(...)
  if not signal_layer_pass(tick, signal):
    return

  if now_ms() - tick.timestamp > signal_max_age_ms:
    return   // SIGNAL_STALE

  if now_ms() - state[tick.symbol].last_order_ts < cooldown_ms:
    return

  if in_flight_count >= max_in_flight_trades:
    return

  direction, _, _ = pick_direction(signal, ...)
  order = build_and_normalize_order(direction, tick)
  if order.qty <= 0:
    return

  reservations = reservationManager.try_reserve(tick.symbol, direction, order, tick)
  if not reservations:
    return   // RESERVE_FAILED，无余额/容量，直接跳过

  in_flight_count++
  execute_trade_async(tick.symbol, order, tick, reservations)


async function execute_trade_async(symbol, order, tick, reservations):
  try:
    if not final_checker.pass(order, tick):
      return
    fill = order_executor.execute_both_legs(order, tick)
    reporter.record_trade(fill, calc_trade_pnl(fill), account_cache)
    state[symbol].last_order_ts = now_ms()
  finally:
    reservationManager.release_all(reservations)
    in_flight_count--
```

## 16. 输出字段

每次开仓或反向抵消记录：

- `symbol`：币种。
- `timestamp`：时间。
- `action`：`OPEN` 或 `CLOSE`。
- `direction`：方向，`-a+b` 或 `+a-b`。
- `close_reason`：主动退出原因；普通开仓可为空。
- `a_price_used`：A 交易所实际成交均价。
- `b_price_used`：B 交易所实际成交均价。
- `qty`：该笔交易数量。
- `a_order_id`：A 交易所订单号。
- `b_order_id`：B 交易所订单号。
- `a_filled_qty`：A 实际成交数量。
- `b_filled_qty`：B 实际成交数量。
- `a_pos_qty`：A 侧持仓（来自 WS 缓存或成交后 REST）。
- `b_pos_qty`：B 侧持仓（来自 WS 缓存或成交后 REST）。
- `net_pnl`：该笔交易利润。
- `cum_pnl`：累计利润。

## 17. 简易实盘注意事项

- **Binance** 须已开通 Portfolio Margin 统一账户；API Key 需有统一账户 / U 本位合约权限。账户与下单走 **papi**，公共行情与 `exchangeInfo` 仍走 **fapi**。
- **Gate** 须已开通 **统一账户**并启用 USDT 永续；余额走 **unified WS + `/unified/accounts`**，仓位走 **fx-ws `futures.positions`**，下单仍走 **`/futures/usdt/orders`**。
- 所有 WS 按第 3 章维护：批量订阅、ping/pong、Binance listenKey 续期、Gate unified/fx-ws 鉴权重连。
- 启动 / 重连：私有 WS **onOpen 内 REST 全量**初始化 cache；运行中 WS **只 merge 变更**（见 3.4）；断线 **不清 cache**。
- 发单前 **必须预占** USDT + 仓位容量（§7.5、§10.5）；`available = total − reserved`。
- A/B 永续账户使用单向净持仓；启动时 REST 同步一次仓位与余额。
- 下单前检查 `minQty` / `stepSize` / `minNotional`。
- 下单后记录真实成交回报；`a_pos_qty` / `b_pos_qty` 读 WS 更新后的缓存，不要手工 `pos ± qty` 记账。
- 接口超时、限频；WS 重连持续失败需告警。
- **单账户多币种**：**预占 + drop-fast**，无队列；`signal_max_age_ms=50`；不够就 `RESERVE_FAILED` skip。
- 状态流：`SIGNAL_OK` → `RESERVE_OK` / `RESERVE_FAILED` → `FINAL_OK` → `TRADE_DONE` → `RESERVE_RELEASED`。


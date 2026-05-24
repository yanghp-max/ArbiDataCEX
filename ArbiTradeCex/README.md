# ArbiTradeCex

CEX–CEX 套利实盘（Binance Portfolio Margin + Gate 统一账户），结构与 [ArbiTrade-1/arb-system](../ArbiTrade-1/arb-system) 同级对齐。

逻辑说明见：[exportAndBackTest/cex_cex_arbitrage_demo_logic.md](../exportAndBackTest/cex_cex_arbitrage_demo_logic.md)

## 快速开始

```bash
cd arb-system
cp .env.template .env
# 编辑 .env 填入 API Key

npm install
npm run start:dry    # 模拟，不下单
npm run start:live   # 实盘（谨慎）
```

## 目录

```
ArbiTradeCex/
  arb-system/           # 主程序（对标 ArbiTrade-1/arb-system）
    strategies/         # 入口脚本
    arbitrage/          # 任务、执行、缓存、信号
    cex/                # Binance + Gate 适配器
    config/
    common/
```

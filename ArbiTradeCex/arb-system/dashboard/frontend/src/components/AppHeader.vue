<script setup>
defineProps({
  connected: { type: Boolean, required: true },
  tradingEnabled: { type: Boolean, required: true },
  useMockAccount: { type: Boolean, required: true },
  pnlSummary: { type: Object, required: true },
  formatPnl: { type: Function, required: true },
  pnlClass: { type: Function, required: true }
});
</script>

<template>
  <header class="header">
    <div>
      <h1>ArbiTradeCex</h1>
      <p class="subtitle">CEX-CEX 实时监控 · Binance / Gate · dashboard v3</p>
    </div>
    <div class="badges">
      <span class="badge" :class="connected ? 'ok' : 'err'">{{ connected ? 'WS 已连接' : 'WS 断开' }}</span>
      <span class="badge" :class="tradingEnabled ? 'warn' : 'muted'">{{ tradingEnabled ? 'LIVE' : 'DRY-RUN' }}</span>
      <span v-if="useMockAccount" class="badge muted">Mock 余额</span>
      <span class="badge pnl" :class="pnlClass(pnlSummary.totalPnl)">
        总 PnL {{ formatPnl(pnlSummary.totalPnl) }} USDT
      </span>
    </div>
  </header>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  state: { type: Object, required: true },
  pnlSummary: { type: Object, required: true },
  fmt: { type: Function, required: true },
  formatPnl: { type: Function, required: true },
  formatTime: { type: Function, required: true }
});

function legLine(exchange, side, price, fmt) {
  if (!side || price == null) return `${exchange} -`;
  return `${exchange} ${side} @${fmt(price, 6)}`;
}

const combinedLogs = computed(() =>
  (props.state.trades || [])
    .map((t) => ({
      id: `trade_${t.timestamp}_${t.symbol}`,
      timestamp: t.timestamp,
      level: 'trade',
      symbol: t.symbol,
      message: [
        `${t.symbol} ${t.action || 'trade'} ${t.direction}`,
        legLine('A', t.aSide, t.aPrice ?? t.aPriceUsed, props.fmt),
        legLine('B', t.bSide, t.bPrice ?? t.bPriceUsed, props.fmt),
        `qty ${props.fmt(t.qty, 4)}`,
        `pnl ${props.fmt(t.netPnl, 4)} USDT${t.simulated ? ' (sim)' : ''}`
      ].join(' · ')
    }))
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 100)
);
</script>

<template>
  <section class="log-panel">
    <div class="log-head">
      <h2>成交日志</h2>
      <span>
        总 PnL {{ formatPnl(pnlSummary.totalPnl) }} USDT ·
        {{ pnlSummary.tradeCount }} 笔成交
      </span>
    </div>
    <div class="log-list">
      <div v-if="combinedLogs.length === 0" class="log-empty">暂无成交记录</div>
      <article v-for="log in combinedLogs" :key="log.id" class="log-item" :class="log.level">
        <div class="log-top">
          <span class="log-time">{{ formatTime(log.timestamp) }}</span>
          <span class="log-symbol">{{ log.symbol || '-' }}</span>
          <span class="log-level">{{ log.level }}</span>
        </div>
        <div class="log-message">{{ log.message }}</div>
      </article>
    </div>
  </section>
</template>

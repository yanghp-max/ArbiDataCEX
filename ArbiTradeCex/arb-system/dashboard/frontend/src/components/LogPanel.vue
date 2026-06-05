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

const combinedLogs = computed(() => {
  const runtimeLogs = (props.state.logs || []).map((l) => ({
    id: l.id || `log_${l.timestamp}`,
    timestamp: l.timestamp,
    level: l.level || 'info',
    symbol: l.symbol || '-',
    message: l.message || ''
  }));
  const tradeLogs = (props.state.trades || []).map((t) => ({
    id: `trade_${t.timestamp}_${t.symbol}`,
    timestamp: t.timestamp,
    level: 'trade',
    symbol: t.symbol,
    message: [
      `${t.symbol} ${t.action || 'trade'} ${t.direction}${t.legExposure ? ' [单腿]' : ''}`,
      legLine('A', t.aSide, t.aPrice ?? t.aPriceUsed, props.fmt) + (t.aFilledQty != null ? ` fill=${props.fmt(t.aFilledQty, 4)}` : ''),
      legLine('B', t.bSide, t.bPrice ?? t.bPriceUsed, props.fmt) + (t.bFilledQty != null ? ` fill=${props.fmt(t.bFilledQty, 4)}` : ''),
      `qty ${props.fmt(t.qty, 4)}`,
      `pnl ${props.fmt(t.netPnl, 4)} USDT${t.simulated ? ' (sim)' : ''}`
    ].join(' · ')
  }));
  return [...runtimeLogs, ...tradeLogs]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 100);
});
</script>

<template>
  <section class="log-panel">
    <div class="log-head">
      <h2>运行日志</h2>
      <span>
        总 PnL {{ formatPnl(pnlSummary.totalPnl) }} USDT ·
        {{ pnlSummary.tradeCount }} 笔成交
      </span>
    </div>
    <div class="log-list">
      <div v-if="combinedLogs.length === 0" class="log-empty">暂无日志</div>
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

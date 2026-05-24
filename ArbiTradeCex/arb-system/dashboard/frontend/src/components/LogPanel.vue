<script setup>
import { computed } from 'vue';

const props = defineProps({
  state: { type: Object, required: true },
  pnlSummary: { type: Object, required: true },
  fmt: { type: Function, required: true },
  formatPnl: { type: Function, required: true },
  formatTime: { type: Function, required: true },
  formatDetail: { type: Function, required: true }
});

const combinedLogs = computed(() => {
  const tradeLogs = (props.state.trades || []).map((t) => ({
    id: `trade_${t.timestamp}_${t.symbol}`,
    timestamp: t.timestamp,
    level: 'trade',
    symbol: t.symbol,
    message: `${t.symbol} ${t.direction} · qty ${t.qty} · pnl ${props.fmt(t.netPnl, 4)} USDT${t.simulated ? ' (sim)' : ''}`,
    detail: t
  }));
  const others = (props.state.logs || []).filter((log) => !String(log.message || '').includes('[FINAL_SKIP]'));
  return [...tradeLogs, ...others]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 100);
});
</script>

<template>
  <section class="log-panel">
    <div class="log-head">
      <h2>交易 / 事件日志</h2>
      <span>
        总 PnL {{ formatPnl(pnlSummary.totalPnl) }} USDT ·
        {{ pnlSummary.tradeCount }} 笔成交
      </span>
    </div>
    <div class="log-list">
      <div v-if="combinedLogs.length === 0" class="log-empty">暂无日志，触发交易后会显示详情</div>
      <article v-for="log in combinedLogs" :key="log.id" class="log-item" :class="log.level">
        <div class="log-top">
          <span class="log-time">{{ formatTime(log.timestamp) }}</span>
          <span class="log-symbol">{{ log.symbol || '-' }}</span>
          <span class="log-level">{{ log.level }}</span>
        </div>
        <div class="log-message">{{ log.message }}</div>
        <pre v-if="log.detail" class="log-detail">{{ formatDetail(log.detail) }}</pre>
      </article>
    </div>
  </section>
</template>

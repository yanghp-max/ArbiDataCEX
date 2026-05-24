<script setup>
defineProps({
  pnlSummary: { type: Object, required: true },
  pnlBySymbolRows: { type: Array, required: true },
  formatPnl: { type: Function, required: true },
  pnlClass: { type: Function, required: true }
});
</script>

<template>
  <section class="pnl-panel">
    <div class="pnl-main">
      <div class="pnl-label">累计 PnL</div>
      <div class="pnl-value" :class="pnlClass(pnlSummary.totalPnl)">
        {{ formatPnl(pnlSummary.totalPnl) }} <small>USDT</small>
      </div>
    </div>
    <div class="pnl-stats">
      <div class="pnl-stat">
        <span class="pnl-stat-label">成交笔数</span>
        <strong>{{ pnlSummary.tradeCount }}</strong>
      </div>
      <div class="pnl-stat">
        <span class="pnl-stat-label">盈利 / 亏损</span>
        <strong>{{ pnlSummary.winCount }} / {{ pnlSummary.lossCount }}</strong>
      </div>
    </div>
    <div v-if="pnlBySymbolRows.length" class="pnl-by-symbol">
      <div v-for="row in pnlBySymbolRows" :key="row.symbol" class="pnl-symbol-row">
        <span>{{ row.symbol }}</span>
        <strong :class="pnlClass(row.pnl)">{{ formatPnl(row.pnl) }}</strong>
      </div>
    </div>
  </section>
</template>

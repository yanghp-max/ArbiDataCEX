<script setup>
import AppHeader from './components/AppHeader.vue';
import PnlPanel from './components/PnlPanel.vue';
import ProgressPanel from './components/ProgressPanel.vue';
import SymbolCard from './components/SymbolCard.vue';
import LogPanel from './components/LogPanel.vue';
import { useDashboardWs } from './composables/useDashboardWs.js';
import { useFormatters } from './composables/useFormatters.js';

const { connected, state, pnlSummary, pnlBySymbolRows, symbolCards } = useDashboardWs();
const {
  fmt,
  fmtPct,
  spreadClass,
  formatTime,
  formatDuration,
  formatDetail,
  statusLabel,
  pnlClass,
  formatPnl
} = useFormatters();
</script>

<template>
  <AppHeader
    :connected="connected"
    :trading-enabled="state.tradingEnabled"
    :use-mock-account="state.useMockAccount"
    :pnl-summary="pnlSummary"
    :format-pnl="formatPnl"
    :pnl-class="pnlClass"
  />

  <PnlPanel
    :pnl-summary="pnlSummary"
    :pnl-by-symbol-rows="pnlBySymbolRows"
    :format-pnl="formatPnl"
    :pnl-class="pnlClass"
  />

  <ProgressPanel
    :progress="state.progress"
    :pnl-summary="pnlSummary"
    :format-duration="formatDuration"
    :format-pnl="formatPnl"
    :pnl-class="pnlClass"
  />

  <section class="cards-grid">
    <SymbolCard
      v-for="card in symbolCards"
      :key="card.symbol"
      :card="card"
      :fmt="fmt"
      :fmt-pct="fmtPct"
      :spread-class="spreadClass"
      :status-label="statusLabel"
    />
  </section>

  <LogPanel
    :state="state"
    :pnl-summary="pnlSummary"
    :fmt="fmt"
    :format-pnl="formatPnl"
    :format-time="formatTime"
    :format-detail="formatDetail"
  />
</template>

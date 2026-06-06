<script setup>
import { computed } from 'vue';

const props = defineProps({
  state: { type: Object, required: true },
  pnlSummary: { type: Object, required: true },
  fmt: { type: Function, required: true },
  formatPnl: { type: Function, required: true },
  formatTime: { type: Function, required: true },
  fmtPct: { type: Function, required: true }
});

function bidAskLine(exchange, bid, ask, fmt) {
  return `${exchange} bid ${fmt(bid, 6)} / ask ${fmt(ask, 6)}`;
}

function legExecLine(exchange, side, nominal, fill, fillQty, fmt) {
  const sideLabel = side || '-';
  const nom = nominal != null ? fmt(nominal, 6) : '-';
  const real = fill != null ? fmt(fill, 6) : '-';
  const qty = fillQty != null ? fmt(fillQty, 4) : '-';
  return `${exchange} ${sideLabel} 名义@${nom} 成交@${real} fill=${qty}`;
}

function slipBps(nominal, fill, side) {
  if (nominal == null || fill == null || !Number.isFinite(nominal) || nominal === 0) return null;
  const raw = ((fill - nominal) / nominal) * 10000;
  if (side === 'sell') return -raw;
  return raw;
}

function fmtSlip(nominal, fill, side) {
  const bps = slipBps(nominal, fill, side);
  if (bps == null || !Number.isFinite(bps)) return '';
  const sign = bps > 0 ? '+' : '';
  return `${sign}${bps.toFixed(2)}bps`;
}

const combinedLogs = computed(() => {
  const runtimeLogs = (props.state.logs || []).map((l) => ({
    id: l.id || `log_${l.timestamp}`,
    timestamp: l.timestamp,
    level: l.level || 'info',
    symbol: l.symbol || '-',
    message: l.message || '',
    trade: null
  }));
  const tradeLogs = (props.state.trades || []).map((t) => ({
    id: `trade_${t.timestamp}_${t.symbol}`,
    timestamp: t.timestamp,
    level: 'trade',
    symbol: t.symbol,
    message: '',
    trade: t
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
        <template v-if="log.trade">
          <div class="log-message trade-head">
            {{ log.trade.symbol }} {{ log.trade.action || 'trade' }} {{ log.trade.direction }}
            <span v-if="log.trade.legExposure" class="trade-warn">[单腿]</span>
            <span v-if="log.trade.simulated" class="trade-sim">(sim)</span>
          </div>
          <div class="log-message trade-quote">
            盘口 {{ bidAskLine('A', log.trade.aBid, log.trade.aAsk, fmt) }}
            · {{ bidAskLine('B', log.trade.bBid, log.trade.bAsk, fmt) }}
          </div>
          <div class="log-message trade-spread">
            价差 Ab {{ fmtPct(log.trade.spreadAbPct) }}
            · Ba {{ fmtPct(log.trade.spreadBaPct) }}
          </div>
          <div class="log-message trade-legs">
            {{ legExecLine('A', log.trade.aSide, log.trade.aPriceNominal, log.trade.aFillPrice, log.trade.aFilledQty, fmt) }}
            <span v-if="fmtSlip(log.trade.aPriceNominal, log.trade.aFillPrice, log.trade.aSide)" class="trade-slip">
              ({{ fmtSlip(log.trade.aPriceNominal, log.trade.aFillPrice, log.trade.aSide) }})
            </span>
          </div>
          <div class="log-message trade-legs">
            {{ legExecLine('B', log.trade.bSide, log.trade.bPriceNominal, log.trade.bFillPrice, log.trade.bFilledQty, fmt) }}
            <span v-if="fmtSlip(log.trade.bPriceNominal, log.trade.bFillPrice, log.trade.bSide)" class="trade-slip">
              ({{ fmtSlip(log.trade.bPriceNominal, log.trade.bFillPrice, log.trade.bSide) }})
            </span>
          </div>
          <div class="log-message trade-summary">
            qty {{ fmt(log.trade.qty, 4) }}
            · pnl {{ fmt(log.trade.netPnl, 4) }} USDT
            · cum {{ fmt(log.trade.cumPnl, 4) }}
            · pos A={{ fmt(log.trade.aPosQty, 4) }} B={{ fmt(log.trade.bPosQty, 4) }}
          </div>
          <div v-if="log.trade.failReason" class="log-message trade-warn-line">
            失败腿 {{ log.trade.failedLeg }}: {{ log.trade.failReason }}
          </div>
        </template>
        <div v-else class="log-message">{{ log.message }}</div>
      </article>
    </div>
  </section>
</template>

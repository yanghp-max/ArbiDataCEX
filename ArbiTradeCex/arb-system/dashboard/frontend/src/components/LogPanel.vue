<script setup>
import { computed } from 'vue';

const props = defineProps({
  state: { type: Object, required: true },
  pnlSummary: { type: Object, required: true },
  fmt: { type: Function, required: true },
  formatPnl: { type: Function, required: true },
  formatTotalPnl: { type: Function, required: true },
  formatTime: { type: Function, required: true },
  fmtPct: { type: Function, required: true },
  pnlClass: { type: Function, required: true }
});

function hasFill(qty) {
  return Number(qty) > 0;
}

function filledLegs(trade) {
  const legs = [];
  if (hasFill(trade.aFilledQty)) {
    legs.push({
      key: 'binance',
      exchange: 'Binance',
      side: trade.aSide,
      bid: trade.aBid,
      ask: trade.aAsk,
      nominal: trade.aPriceNominal,
      fill: trade.aFillPrice,
      qty: trade.aFilledQty,
      orderId: trade.aOrderId
    });
  }
  if (hasFill(trade.bFilledQty)) {
    legs.push({
      key: 'gate',
      exchange: 'Gate',
      side: trade.bSide,
      bid: trade.bBid,
      ask: trade.bAsk,
      nominal: trade.bPriceNominal,
      fill: trade.bFillPrice,
      qty: trade.bFilledQty,
      orderId: trade.bOrderId
    });
  }
  return legs;
}

/** 滑点与展示价对齐（避免 Binance 多精度小数造成假滑点） */
function decimalPlacesFromPrice(price) {
  const s = String(price);
  const i = s.indexOf('.');
  if (i === -1) return 0;
  return s.length - i - 1;
}

function roundPrice(price, decimals) {
  if (!Number.isFinite(Number(price))) return NaN;
  if (decimals <= 0) return Math.round(Number(price));
  const f = 10 ** decimals;
  return Math.round(Number(price) * f) / f;
}

function nominalPriceForLeg(leg) {
  if (leg.nominal != null && Number.isFinite(Number(leg.nominal))) return Number(leg.nominal);
  if (leg.side === 'sell' && leg.bid != null) return Number(leg.bid);
  if (leg.side === 'buy' && leg.ask != null) return Number(leg.ask);
  return null;
}

function calcLegSlippageBps(leg) {
  const nominal = nominalPriceForLeg(leg);
  const fill = Number(leg.fill);
  if (!Number.isFinite(nominal) || nominal === 0 || !Number.isFinite(fill)) return null;
  const dp = Math.max(decimalPlacesFromPrice(nominal), 6);
  const refR = roundPrice(nominal, dp);
  const fillR = roundPrice(fill, dp);
  if (refR === fillR) return 0;
  const raw = ((fillR - refR) / refR) * 10000;
  return leg.side === 'sell' ? -raw : raw;
}

function formatPriceForDisplay(price, refPrice = price) {
  const dp = Math.max(decimalPlacesFromPrice(refPrice), 6);
  const rounded = roundPrice(price, dp);
  if (!Number.isFinite(rounded)) return '—';
  return rounded.toFixed(dp);
}

function formatSlippageBps(bps) {
  if (bps == null || !Number.isFinite(bps)) return null;
  if (Math.abs(bps) < 0.005) return '0.00 bps';
  const sign = bps > 0 ? '+' : '';
  return `${sign}${bps.toFixed(2)} bps`;
}

/** 名义价 = 下单时用的盘口：卖@bid，买@ask（与后端 legPricesForDirection 一致） */
function legQuoteRef(leg) {
  const nominal = nominalPriceForLeg(leg);
  if (nominal == null) return null;
  if (leg.side === 'sell') return { tag: 'bid', price: nominal };
  if (leg.side === 'buy') return { tag: 'ask', price: nominal };
  return { tag: '名义', price: nominal };
}

function legExecLine(leg, fmtFn) {
  const ref = legQuoteRef(leg);
  if (!ref) {
    return `成交 ${leg.fill != null ? fmtFn(leg.fill, 6) : '—'}`;
  }
  const fill = leg.fill != null ? formatPriceForDisplay(leg.fill, ref.price) : '—';
  const quote = formatPriceForDisplay(ref.price, ref.price);
  const slip = formatSlippageBps(calcLegSlippageBps(leg));
  const slipPart = slip ? `  滑点 ${slip}` : '';
  return `盘口 ${ref.tag} ${quote} → 成交价 ${fill}${slipPart}`;
}

function sideLabel(side) {
  if (side === 'buy') return '买入';
  if (side === 'sell') return '卖出';
  return side || '-';
}

function hasDualLegGross(trade) {
  return trade.grossPnl != null && Number.isFinite(Number(trade.grossPnl));
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
    trade: t,
    filledLegs: filledLegs(t)
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
        总 PnL {{ formatTotalPnl(pnlSummary) }} USDT ·
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
          <div
            v-if="log.trade.spreadAbPct != null || log.trade.spreadBaPct != null"
            class="log-message trade-spread"
          >
            信号价差 Ab {{ fmtPct(log.trade.spreadAbPct) }}
            · Ba {{ fmtPct(log.trade.spreadBaPct) }}
          </div>
          <template v-if="log.filledLegs.length">
            <div
              v-for="leg in log.filledLegs"
              :key="leg.key"
              class="log-message trade-leg-block"
              :class="`trade-leg-${leg.key}`"
            >
              <div class="trade-leg-title">
                {{ leg.exchange }} {{ sideLabel(leg.side) }}
                <span class="trade-leg-qty">成交 {{ fmt(leg.qty, 4) }}</span>
              </div>
              <div class="trade-leg-prices">
                {{ legExecLine(leg, fmt) }}
              </div>
              <div v-if="leg.orderId" class="trade-leg-order">订单 {{ leg.orderId }}</div>
            </div>
          </template>
          <div v-else class="log-message trade-warn-line">无成交</div>
          <div class="log-message trade-profit" :class="pnlClass(log.trade.pnlComplete === false ? null : log.trade.netPnl)">
            <strong>实际利润</strong>
            <template v-if="log.trade.pnlComplete === false || log.trade.netPnl == null">
              待确认（Gate/Binance fee 回执未齐）
            </template>
            <template v-else-if="hasDualLegGross(log.trade)">
              毛 {{ formatPnl(log.trade.grossPnl) }} USDT · 净 {{ formatPnl(log.trade.netPnl) }} USDT
              <span v-if="log.trade.feeCost > 0"> · 手续费 -{{ fmt(log.trade.feeCost, 4) }}</span>
            </template>
            <template v-else>
              净 {{ formatPnl(log.trade.netPnl) }} USDT
              <span v-if="log.trade.legExposure" class="trade-warn">（单腿，无对冲价差）</span>
            </template>
          </div>
          <div class="log-message trade-summary">
            计划 qty {{ fmt(log.trade.qty, 4) }}
            · cum {{ fmt(log.trade.cumPnl, 4) }}
            · pos Binance={{ fmt(log.trade.aPosQty, 4) }} Gate={{ fmt(log.trade.bPosQty, 4) }}
          </div>
          <div v-if="log.trade.failReason" class="log-message trade-warn-line">
            未成交 {{ log.trade.failedLeg === 'binance' ? 'Binance' : log.trade.failedLeg === 'gate' ? 'Gate' : log.trade.failedLeg }}:
            {{ log.trade.failReason }}
          </div>
        </template>
        <div v-else class="log-message">{{ log.message }}</div>
      </article>
    </div>
  </section>
</template>

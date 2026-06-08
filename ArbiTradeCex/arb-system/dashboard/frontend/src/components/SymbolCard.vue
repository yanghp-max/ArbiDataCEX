<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';

const props = defineProps({
  card: { type: Object, required: true },
  showLatency: { type: Boolean, default: true },
  enforceLatency: { type: Boolean, default: false },
  latencyLimits: { type: Object, default: null },
  fmt: { type: Function, required: true },
  fmtMs: { type: Function, required: true },
  fmtPct: { type: Function, required: true },
  spreadClass: { type: Function, required: true },
  statusLabel: { type: Function, required: true }
});

const nowMs = ref(Date.now());
let tickTimer = null;

onMounted(() => {
  tickTimer = setInterval(() => {
    nowMs.value = Date.now();
  }, 100);
});

onUnmounted(() => {
  if (tickTimer) clearInterval(tickTimer);
});

function legAgeMs(localTs) {
  const ts = Number(localTs);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  return Math.max(0, nowMs.value - ts);
}

const aAgeLive = computed(() => legAgeMs(props.card.aLocalTimestamp) ?? props.card.aAgeMs ?? null);
const bAgeLive = computed(() => legAgeMs(props.card.bLocalTimestamp) ?? props.card.bAgeMs ?? null);

const priceAgeLive = computed(() => {
  const ages = [aAgeLive.value, bAgeLive.value].filter((v) => v != null);
  if (!ages.length) return props.card.priceAgeMs ?? null;
  return Math.max(...ages);
});

const legSkewLive = computed(() => {
  if (aAgeLive.value != null && bAgeLive.value != null) {
    return Math.abs(aAgeLive.value - bAgeLive.value);
  }
  return props.card.legSkewMs ?? null;
});

const wsLatencyLive = computed(() => {
  const a = props.card.aLatencyMs;
  const b = props.card.bLatencyMs;
  if (!Number.isFinite(a) && !Number.isFinite(b)) return props.card.maxWsLatencyMs ?? null;
  return Math.max(Number.isFinite(a) ? a : -1, Number.isFinite(b) ? b : -1);
});

function liveStaleReason() {
  const limits = props.latencyLimits;
  if (!props.enforceLatency || !limits) return props.card.staleReason ?? null;
  if (props.card.aBid == null) return null;

  const priceAge = priceAgeLive.value;
  const legSkew = legSkewLive.value ?? 0;
  const ws = wsLatencyLive.value;

  if (priceAge != null && priceAge > limits.maxPriceAgeMs) {
    return `行情太旧 ${Math.round(priceAge)}/${limits.maxPriceAgeMs}ms`;
  }
  if (legSkew > limits.maxLegSkewMs) {
    return `两腿不同步 ${Math.round(legSkew)}/${limits.maxLegSkewMs}ms`;
  }
  if (ws != null && ws >= 0 && ws > limits.maxWsLatencyMs) {
    return `WS延迟 ${Math.round(ws)}/${limits.maxWsLatencyMs}ms`;
  }
  return null;
}

const effectiveStatus = computed(() => {
  if (props.card.status === 'waiting_quotes' || props.card.aBid == null) {
    return 'waiting_quotes';
  }
  if (!props.enforceLatency) {
    return props.card.windowReady ? 'ready' : 'collecting';
  }
  return liveStaleReason() ? 'stale' : (props.card.windowReady ? 'ready' : 'collecting');
});

const staleHint = computed(() => liveStaleReason() ?? props.card.staleReason ?? null);
</script>

<template>
  <article class="symbol-card" :class="effectiveStatus">
    <div class="card-head">
      <h3>{{ card.symbol }}</h3>
      <span class="status-tag">{{ statusLabel(effectiveStatus) }}</span>
    </div>

    <div class="exchange-row">
      <div class="exchange">
        <div class="exchange-name binance">Binance</div>
        <div class="quote-line"><span>Bid</span><strong>{{ fmt(card.aBid) }}</strong></div>
        <div class="quote-line"><span>Ask</span><strong>{{ fmt(card.aAsk) }}</strong></div>
      </div>
      <div class="exchange">
        <div class="exchange-name gate">Gate</div>
        <div class="quote-line"><span>Bid</span><strong>{{ fmt(card.bBid) }}</strong></div>
        <div class="quote-line"><span>Ask</span><strong>{{ fmt(card.bAsk) }}</strong></div>
      </div>
    </div>

    <div class="spread-block">
      <div class="spread-row">
        <span class="spread-label">Spread A→B</span>
        <strong :class="spreadClass(card.spreadAbAdj)">{{ fmtPct(card.spreadAb) }}</strong>
        <small>adj {{ fmtPct(card.spreadAbAdj) }}</small>
      </div>
      <div class="spread-row">
        <span class="spread-label">Spread B→A</span>
        <strong :class="spreadClass(card.spreadBaAdj)">{{ fmtPct(card.spreadBa) }}</strong>
        <small>adj {{ fmtPct(card.spreadBaAdj) }}</small>
      </div>
    </div>

    <div class="z-row" :class="{ 'z-row--hidden': !card.windowReady }">
      <span>openZ ab/ba {{ fmt(card.openZAb, 2) }} / {{ fmt(card.openZBa, 2) }}</span>
      <span>closeZ ab/ba {{ fmt(card.closeZAb, 2) }} / {{ fmt(card.closeZBa, 2) }}</span>
    </div>
    <div class="z-row z-row--lock" :class="{ 'z-row--hidden': !card.lockedDirection }">
      <span>lock {{ card.lockedDirection || '-' }} · branch {{ card.lockedBranch || '-' }}</span>
    </div>
    <div v-if="staleHint" class="stale-hint">{{ staleHint }}</div>
    <div class="card-metrics">
      <template v-if="showLatency">
        <div class="meta-line">
          <span class="meta-label">行情年龄</span>
          <span class="meta-value">{{ fmtMs(priceAgeLive) }} ms</span>
        </div>
        <div class="meta-line">
          <span class="meta-label">A腿年龄 (Binance)</span>
          <span class="meta-value">{{ fmtMs(aAgeLive) }} ms</span>
        </div>
        <div class="meta-line">
          <span class="meta-label">B腿年龄 (Gate)</span>
          <span class="meta-value">{{ fmtMs(bAgeLive) }} ms</span>
        </div>
        <div class="meta-line">
          <span class="meta-label">两腿时差</span>
          <span class="meta-value">{{ fmtMs(legSkewLive) }} ms</span>
        </div>
        <div class="meta-line">
          <span class="meta-label">WS延迟 A (Binance)</span>
          <span class="meta-value">{{ fmtMs(card.aLatencyMs) }} ms</span>
        </div>
        <div class="meta-line">
          <span class="meta-label">WS延迟 B (Gate)</span>
          <span class="meta-value">{{ fmtMs(card.bLatencyMs) }} ms</span>
        </div>
      </template>
      <div v-else class="meta-line meta-line--muted">
        <span class="meta-label">延迟</span>
        <span class="meta-value">未启用</span>
      </div>
      <div class="meta-line">
        <span class="meta-label">Funding A / B</span>
        <span class="meta-value">{{ fmt(card.fundingA, 4) }} / {{ fmt(card.fundingB, 4) }}</span>
      </div>
    </div>
  </article>
</template>

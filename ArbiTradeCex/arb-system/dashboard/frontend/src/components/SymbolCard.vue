<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';

const props = defineProps({
  card: { type: Object, required: true },
  exchangeA: { type: String, default: 'A' },
  exchangeB: { type: String, default: 'B' },
  showLatency: { type: Boolean, default: true },
  enforceLatency: { type: Boolean, default: false },
  latencyLimits: { type: Object, default: null },
  fmt: { type: Function, required: true },
  fmtMs: { type: Function, required: true },
  fmtPct: { type: Function, required: true },
  fmtFundingRate: { type: Function, required: true },
  spreadClass: { type: Function, required: true },
  statusLabel: { type: Function, required: true },
  onSyncPosition: { type: Function, required: true }
});

/** 进入/退出滞回，避免在阈值附近闪烁 */
const STALE_EXIT_RATIO = 0.75;
const STALE_HOLD_MS = 2000;
const STALE_RECOVER_MS = 1000;

const displayStale = ref(false);
const displayStaleReason = ref('');
let staleShownAt = 0;
let recoverStartedAt = 0;
const syncingPosition = ref(false);
const syncError = ref('');
onMounted(() => {
  syncStaleDisplay();
});

onUnmounted(() => {
  // no periodic timing extrapolation
});

watch(() => props.card.symbol, () => {
  displayStale.value = false;
  displayStaleReason.value = '';
  staleShownAt = 0;
  recoverStartedAt = 0;
  syncingPosition.value = false;
  syncError.value = '';
});

/** 服务端推送时的年龄 + 本地流逝，避免 WS 高频推送把显示恒为 0 */
const wsLatencyLive = computed(() => {
  const a = props.card.aLatencyMs;
  const b = props.card.bLatencyMs;
  if (!Number.isFinite(a) && !Number.isFinite(b)) return props.card.maxWsLatencyMs ?? null;
  return Math.max(Number.isFinite(a) ? a : -1, Number.isFinite(b) ? b : -1);
});

function rawStaleReason() {
  const limits = props.latencyLimits;
  if (!props.enforceLatency || !limits) return null;
  if (props.card.aBid == null) return null;

  const ws = wsLatencyLive.value;
  if (ws != null && ws >= 0 && ws > limits.maxWsLatencyMs) {
    return `WS延迟 ${Math.ceil(ws)}/${limits.maxWsLatencyMs}ms`;
  }
  return null;
}

function isRecoveredFromStale() {
  const limits = props.latencyLimits;
  if (!limits) return true;
  const ws = wsLatencyLive.value;
  const wsOk = ws == null || ws < 0 || ws <= limits.maxWsLatencyMs * STALE_EXIT_RATIO;
  return wsOk;
}

function syncStaleDisplay() {
  const reason = rawStaleReason();
  const now = Date.now();

  if (reason) {
    displayStale.value = true;
    displayStaleReason.value = reason;
    staleShownAt = staleShownAt || now;
    recoverStartedAt = 0;
    return;
  }

  if (!displayStale.value) return;

  if (!isRecoveredFromStale()) {
    recoverStartedAt = 0;
    return;
  }

  if (!recoverStartedAt) recoverStartedAt = now;
  const heldLongEnough = now - staleShownAt >= STALE_HOLD_MS;
  const recoveredLongEnough = now - recoverStartedAt >= STALE_RECOVER_MS;
  if (heldLongEnough && recoveredLongEnough) {
    displayStale.value = false;
    displayStaleReason.value = '';
    staleShownAt = 0;
    recoverStartedAt = 0;
  }
}

const effectiveStatus = computed(() => {
  if (props.card.aBid == null || props.card.bBid == null) {
    return 'waiting_quotes';
  }
  if (!props.enforceLatency) {
    return props.card.windowReady ? 'ready' : 'collecting';
  }
  return displayStale.value ? 'stale' : (props.card.windowReady ? 'ready' : 'collecting');
});

async function syncPositionNow() {
  syncingPosition.value = true;
  syncError.value = '';
  try {
    await props.onSyncPosition(props.card.symbol);
  } catch (err) {
    syncError.value = err?.message || String(err);
  } finally {
    syncingPosition.value = false;
  }
}

</script>

<template>
  <article class="symbol-card" :class="effectiveStatus">
    <div class="card-head">
      <h3>{{ card.symbol }}</h3>
      <div class="card-head-actions">
        <span class="status-tag">{{ statusLabel(effectiveStatus) }}</span>
        <button type="button" class="btn btn-mini btn-muted" :disabled="syncingPosition" @click="syncPositionNow">
          {{ syncingPosition ? '读仓中…' : '读仓' }}
        </button>
      </div>
    </div>
    <div v-if="syncError" class="card-error">{{ syncError }}</div>

    <div class="exchange-row">
      <div class="exchange">
        <div class="exchange-name binance">{{ exchangeA }}</div>
        <div class="quote-line"><span>Bid</span><strong>{{ fmt(card.aBid) }}</strong></div>
        <div class="quote-line"><span>Ask</span><strong>{{ fmt(card.aAsk) }}</strong></div>
      </div>
      <div class="exchange">
        <div class="exchange-name gate">{{ exchangeB }}</div>
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
    <div class="stale-hint-slot" aria-live="polite">
      <div class="stale-hint" :class="{ 'stale-hint--on': displayStale }">{{ displayStaleReason }}</div>
    </div>
    <div class="card-metrics">
      <template v-if="showLatency">
        <div class="meta-line">
          <span class="meta-label">WS延迟 A / B</span>
          <span class="meta-value">{{ fmtMs(card.aLatencyMs) }} / {{ fmtMs(card.bLatencyMs) }} ms</span>
        </div>
      </template>
      <div v-else class="meta-line meta-line--muted">
        <span class="meta-label">延迟</span>
        <span class="meta-value">未启用</span>
      </div>
      <div class="meta-line">
        <span class="meta-label">Funding A / B (%)</span>
        <span class="meta-value">{{ fmtFundingRate(card.fundingA) }} / {{ fmtFundingRate(card.fundingB) }}</span>
      </div>
    </div>
  </article>
</template>

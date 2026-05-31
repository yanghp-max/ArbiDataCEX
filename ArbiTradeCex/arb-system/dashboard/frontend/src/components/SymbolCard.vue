<script setup>
defineProps({
  card: { type: Object, required: true },
  fmt: { type: Function, required: true },
  fmtPct: { type: Function, required: true },
  spreadClass: { type: Function, required: true },
  statusLabel: { type: Function, required: true }
});
</script>

<template>
  <article class="symbol-card" :class="card.status">
    <div class="card-head">
      <h3>{{ card.symbol }}</h3>
      <span class="status-tag">{{ statusLabel(card.status) }}</span>
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

    <div v-if="card.windowReady" class="z-row">
      <span>openZ ab/ba {{ fmt(card.openZAb, 2) }} / {{ fmt(card.openZBa, 2) }}</span>
      <span>closeZ ab/ba {{ fmt(card.closeZAb, 2) }} / {{ fmt(card.closeZBa, 2) }}</span>
    </div>
    <div v-if="card.lockedDirection" class="z-row">
      <span>lock {{ card.lockedDirection }} · branch {{ card.lockedBranch }}</span>
    </div>
    <div class="meta-row">
      <span>price age {{ fmt(card.priceAgeMs, 0) }}ms · leg A/B {{ fmt(card.aAgeMs, 0) }}/{{ fmt(card.bAgeMs, 0) }}ms</span>
      <span>lat A/B {{ fmt(card.aLatencyMs, 0) }}/{{ fmt(card.bLatencyMs, 0) }}ms</span>
    </div>
    <div class="meta-row">
      <span>funding A/B {{ fmt(card.fundingA, 4) }} / {{ fmt(card.fundingB, 4) }}</span>
    </div>
  </article>
</template>

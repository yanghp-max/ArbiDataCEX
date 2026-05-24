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
      <span>zAb {{ fmt(card.zAb, 2) }}</span>
      <span>zBa {{ fmt(card.zBa, 2) }}</span>
    </div>
    <div class="meta-row">
      <span>age {{ card.priceAgeMs != null ? card.priceAgeMs + 'ms' : '-' }}</span>
      <span>funding A/B {{ fmt(card.fundingA, 4) }} / {{ fmt(card.fundingB, 4) }}</span>
    </div>
  </article>
</template>

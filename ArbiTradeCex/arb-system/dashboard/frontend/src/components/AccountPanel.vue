<script setup>
import { ref } from 'vue';

const props = defineProps({
  account: { type: Object, default: null },
  accountBaseline: { type: Object, default: null },
  realizedPnl: { type: Number, default: 0 },
  formatPnl: { type: Function, required: true },
  pnlClass: { type: Function, required: true },
  formatTime: { type: Function, required: true },
  onRefresh: { type: Function, required: true }
});

const loading = ref(false);
const error = ref('');

async function refresh() {
  loading.value = true;
  error.value = '';
  try {
    await props.onRefresh();
  } catch (e) {
    error.value = e.message || String(e);
  } finally {
    loading.value = false;
  }
}

function fmtU(v) {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  return Number(v).toFixed(2);
}
</script>

<template>
  <section class="account-panel">
    <div class="account-head">
      <div>
        <div class="account-title">账户权益 (U)</div>
        <p class="account-hint">
          启动时自动查一次；需要时再点按钮。盈亏以启动时总 U 为基准。
        </p>
      </div>
      <div class="account-actions">
        <button type="button" class="btn" :disabled="loading" @click="refresh">
          {{ loading ? '查询中…' : '刷新账户 U' }}
        </button>
      </div>
    </div>

    <p v-if="error" class="account-error">{{ error }}</p>

    <template v-if="account">
      <div class="account-total">
        <span class="account-total-label">当前总 U</span>
        <strong class="account-total-value">{{ fmtU(account.totalUsdt) }}</strong>
        <small>USDT</small>
        <span v-if="account.mock" class="badge muted">Mock</span>
      </div>

      <div class="account-grid">
        <div class="account-card">
          <span class="account-card-label">Binance</span>
          <strong>{{ fmtU(account.binance?.usdt) }}</strong>
          <small>可用 {{ fmtU(account.binance?.available) }}</small>
        </div>
        <div class="account-card">
          <span class="account-card-label">Gate</span>
          <strong>{{ fmtU(account.gate?.usdt) }}</strong>
          <small>可用 {{ fmtU(account.gate?.available) }}</small>
        </div>
        <div class="account-card">
          <span class="account-card-label">较启动盈亏</span>
          <strong :class="pnlClass(account.vsBaselineUsdt)">
            {{ formatPnl(account.vsBaselineUsdt) }}
          </strong>
          <small v-if="accountBaseline">启动时 {{ fmtU(accountBaseline.totalUsdt) }} U</small>
        </div>
        <div class="account-card">
          <span class="account-card-label">成交累计 PnL</span>
          <strong :class="pnlClass(realizedPnl)">{{ formatPnl(realizedPnl) }}</strong>
          <small>按每笔成交累加</small>
        </div>
      </div>

      <div v-if="account.positions?.length" class="account-positions">
        <div class="account-pos-title">持仓 ({{ account.positionCount }})</div>
        <div
          v-for="p in account.positions"
          :key="p.symbol"
          class="account-pos-row"
        >
          <span>{{ p.symbol }}</span>
          <span>A {{ p.aQty }} · B {{ p.bQty }}</span>
          <span v-if="p.netNotional != null">≈ {{ fmtU(p.netNotional) }} U</span>
        </div>
      </div>

      <p class="account-updated">更新于 {{ formatTime(account.at) }}</p>
    </template>
    <p v-else class="account-empty">正在加载账户数据…若过久未显示可点「刷新账户 U」。</p>
  </section>
</template>

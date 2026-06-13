<script setup>
import { ref } from 'vue';

const props = defineProps({
  account: { type: Object, default: null },
  accountBaseline: { type: Object, default: null },
  realizedPnl: { type: Number, default: 0 },
  formatPnl: { type: Function, required: true },
  pnlClass: { type: Function, required: true },
  formatTime: { type: Function, required: true },
  onRefresh: { type: Function, required: true },
  onReloadConfig: { type: Function, required: true }
});

const loading = ref(false);
const reloading = ref(false);
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

async function reloadConfig() {
  reloading.value = true;
  error.value = '';
  try {
    await props.onReloadConfig();
  } catch (e) {
    error.value = e.message || String(e);
  } finally {
    reloading.value = false;
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
        <div class="account-title">账户资金 (USDT)</div>
        <p class="account-hint">
          展示各所<strong>实际可用</strong>与<strong>占用保证金</strong>（与下单预占用一致）。权益 = 可用 + 占用（±浮盈亏）。
        </p>
      </div>
      <div class="account-actions">
        <button type="button" class="btn" :disabled="loading" @click="refresh">
          {{ loading ? '查询中…' : '刷新账户 U' }}
        </button>
        <button type="button" class="btn" :disabled="reloading" @click="reloadConfig">
          {{ reloading ? '重载中…' : '重载配置' }}
        </button>
      </div>
    </div>

    <p v-if="error" class="account-error">{{ error }}</p>

    <template v-if="account">
      <div class="account-summary-row">
        <div class="account-summary-item">
          <span class="account-summary-label">合计实际可用</span>
          <strong class="account-summary-value avail">{{ fmtU(account.totalAvailableUsdt) }}</strong>
        </div>
        <div class="account-summary-item">
          <span class="account-summary-label">合计占用保证金</span>
          <strong class="account-summary-value used">{{ fmtU(account.totalMarginUsedUsdt) }}</strong>
        </div>
        <div class="account-summary-item">
          <span class="account-summary-label">合计权益</span>
          <strong class="account-summary-value">{{ fmtU(account.totalUsdt) }}</strong>
        </div>
        <span v-if="account.mock" class="badge muted">Mock</span>
      </div>

      <div class="account-exchange-grid">
        <article class="account-exchange-card">
          <header class="account-exchange-head">Binance PM</header>
          <div class="account-metric primary">
            <span class="account-metric-label">实际可用</span>
            <strong class="account-metric-value avail">{{ fmtU(account.binance?.available) }}</strong>
          </div>
          <div class="account-metric">
            <span class="account-metric-label">占用保证金</span>
            <strong class="account-metric-value used">{{ fmtU(account.binance?.marginUsed) }}</strong>
          </div>
          <div class="account-metric subtle">
            <span class="account-metric-label">账户权益</span>
            <span>{{ fmtU(account.binance?.equity ?? account.binance?.usdt) }}</span>
          </div>
        </article>

        <article class="account-exchange-card">
          <header class="account-exchange-head">Gate USDT 永续</header>
          <div class="account-metric primary">
            <span class="account-metric-label">实际可用</span>
            <strong class="account-metric-value avail">{{ fmtU(account.gate?.available) }}</strong>
          </div>
          <div class="account-metric">
            <span class="account-metric-label">占用保证金</span>
            <strong class="account-metric-value used">{{ fmtU(account.gate?.marginUsed) }}</strong>
          </div>
          <div class="account-metric subtle">
            <span class="account-metric-label">账户权益</span>
            <span>{{ fmtU(account.gate?.equity ?? account.gate?.usdt) }}</span>
          </div>
        </article>
      </div>

      <div class="account-grid">
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
        <div v-if="account.unrealizedPnlUsdt != null" class="account-card">
          <span class="account-card-label">持仓浮盈浮亏</span>
          <strong :class="pnlClass(account.unrealizedPnlUsdt)">
            {{ formatPnl(account.unrealizedPnlUsdt) }}
          </strong>
          <small>两所未实现盈亏合计</small>
        </div>
      </div>

      <div v-if="account.positions?.length" class="account-positions">
        <div class="account-pos-title">持仓 ({{ account.positionCount }})</div>
        <div
          v-for="p in account.positions"
          :key="p.symbol"
          class="account-pos-block"
        >
          <div class="account-pos-row account-pos-head">
            <span>{{ p.symbol }}</span>
            <span v-if="p.hedgedBaseQty">对冲 {{ Math.round(p.hedgedBaseQty) }} 币</span>
          </div>
          <div class="account-pos-row">
            <span>Binance</span>
            <span>{{ p.aQty }} 币</span>
            <span v-if="p.aInitialMargin > 0">占用 {{ fmtU(p.aInitialMargin) }}U</span>
            <span v-if="p.aUnrealizedPnl != null" :class="pnlClass(p.aUnrealizedPnl)">
              浮盈浮亏 {{ formatPnl(p.aUnrealizedPnl) }}
            </span>
          </div>
          <div class="account-pos-row">
            <span>Gate</span>
            <span>{{ p.bQty }} 币</span>
            <span v-if="p.bInitialMargin > 0">占用 {{ fmtU(p.bInitialMargin) }}U</span>
            <span v-if="p.bUnrealizedPnl != null" :class="pnlClass(p.bUnrealizedPnl)">
              浮盈浮亏 {{ formatPnl(p.bUnrealizedPnl) }}
            </span>
          </div>
        </div>
      </div>

      <p class="account-updated">更新于 {{ formatTime(account.at) }}</p>
    </template>
    <p v-else class="account-empty">正在加载账户数据…若过久未显示可点「刷新账户 U」。</p>
  </section>
</template>

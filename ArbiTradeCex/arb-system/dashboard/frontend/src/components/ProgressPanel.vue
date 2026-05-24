<script setup>
defineProps({
  progress: { type: Object, required: true },
  formatDuration: { type: Function, required: true }
});
</script>

<template>
  <section class="progress-panel">
    <div class="progress-head">
      <h2>数据收集进度</h2>
      <span class="progress-meta">
        总体 {{ progress.overallPct }}% ·
        窗口 {{ formatDuration(progress.windowSeconds) }} ·
        最少样本 {{ progress.minDataPoints }}
      </span>
    </div>
    <div class="progress-bar">
      <div class="progress-fill" :style="{ width: progress.overallPct + '%' }" />
    </div>
    <div class="progress-symbols">
      <div v-for="(p, sym) in progress.symbols" :key="sym" class="progress-item">
        <div class="progress-item-head">
          <span>{{ sym }}</span>
          <span>{{ p.collectProgressPct }}%</span>
        </div>
        <div class="progress-bar thin">
          <div class="progress-fill" :style="{ width: p.collectProgressPct + '%' }" />
        </div>
        <div class="progress-detail">
          样本 {{ p.samples }}/{{ progress.minDataPoints }} ·
          时间跨度 {{ formatDuration(Math.floor((p.timeSpanMs || 0) / 1000)) }} ·
          {{ p.windowReady ? '已就绪' : '收集中' }}
        </div>
      </div>
    </div>
  </section>
</template>

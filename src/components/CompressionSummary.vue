<script setup lang="ts">
import type { CompressionStats } from '../core/compression/stats';

defineProps<{ stats: CompressionStats }>();
const emit = defineEmits<{ clear: []; cancelAll: []; start: [] }>();

function formatBytes(value: number): string {
  if (!value) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return (value / 1024 ** index).toFixed(index === 0 ? 0 : 1) + ' ' + units[index];
}
</script>

<template>
  <footer class="summary">
    <div>
      <strong>{{ stats.completed }}</strong><span>完成</span>
      <strong>{{ stats.partial }}</strong><span>部分成功</span>
      <strong>{{ stats.failed + stats.outputFailed }}</strong><span>失败</span>
      <strong>{{ formatBytes(stats.savedBytes) }}</strong><span>节省</span>
    </div>
    <div class="summary__actions">
      <button type="button" class="primary" :disabled="stats.draft === 0" @click="emit('start')">开始处理 ({{ stats.draft }})</button>
      <button v-if="stats.active || stats.pending" type="button" class="secondary" @click="emit('cancelAll')">取消全部</button>
      <button type="button" class="secondary" @click="emit('clear')">清空列表</button>
    </div>
  </footer>
</template>

<style scoped>
.summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-top: 18px;
  border-top: 1px solid #e2e8f0;
}
.summary > div:first-child {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 6px;
}
.summary strong {
  margin-left: 12px;
  color: #172033;
  font-size: 18px;
}
.summary span {
  color: #64748b;
  font-size: 12px;
}
.summary__actions {
  display: flex;
  gap: 8px;
}
button {
  min-height: 40px;
  padding: 0 13px;
  border: 1px solid #cbd5e1;
  border-radius: 10px;
  background: white;
  color: #334155;
  cursor: pointer;
}
button.secondary:hover,
button:focus-visible {
  border-color: #2563eb;
}
</style>

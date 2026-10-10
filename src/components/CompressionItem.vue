<script setup lang="ts">
import type { CompressionTask } from '../core/compression/types';

defineProps<{ task: CompressionTask; canDownload?: boolean }>();
const emit = defineEmits<{
  cancel: [taskId: string];
  retry: [taskId: string];
  download: [taskId: string];
  replace: [taskId: string];
  copy: [taskId: string];
}>();

function formatBytes(value: number | undefined): string {
  if (!value) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return (value / 1024 ** index).toFixed(index === 0 ? 0 : 1) + ' ' + units[index];
}

function statusText(task: CompressionTask): string {
  if (task.status === 'completed') return '已完成';
  if (task.status === 'failed') return task.error?.message ?? '压缩失败';
  if (task.status === 'canceled') return '已取消';
  if (task.status === 'reading') return '读取中';
  if (task.status === 'compressing') return '压缩中';
  if (task.status === 'writing') return '保存中';
  return '等待中';
}
</script>

<template>
  <article class="item">
    <div class="item__main">
      <div class="item__icon" aria-hidden="true">IMG</div>
      <div class="item__copy">
        <strong :title="task.source.relativePath">{{ task.source.name }}</strong>
        <span>{{ formatBytes(task.originalSize) }} · {{ statusText(task) }}</span>
      </div>
      <div class="item__result">
        <strong v-if="task.status === 'completed'">{{ formatBytes(task.compressedSize) }}</strong>
        <span v-if="task.status === 'completed'">
          节省 {{ Math.max(0, 100 - ((task.compressedSize ?? task.originalSize) / task.originalSize) * 100).toFixed(1) }}%
        </span>
      </div>
      <div class="item__actions">
        <button v-if="task.status === 'pending' || task.status === 'reading' || task.status === 'compressing' || task.status === 'writing'" type="button" aria-label="取消压缩" @click="emit('cancel', task.id)">取消</button>
        <button v-if="task.status === 'failed' || task.status === 'canceled'" type="button" aria-label="重试压缩" @click="emit('retry', task.id)">重试</button>
        <button v-if="task.status === 'completed' && canDownload" type="button" aria-label="下载压缩图片" @click="emit('download', task.id)">下载</button>
        <button v-if="task.status === 'completed'" type="button" aria-label="覆盖原图" @click="emit('replace', task.id)">覆盖</button>
        <button v-if="task.status === 'completed'" type="button" aria-label="复制图片" @click="emit('copy', task.id)">复制</button>
      </div>
    </div>
    <div v-if="task.status !== 'completed' && task.status !== 'failed' && task.status !== 'canceled'" class="item__progress" role="progressbar" :aria-valuenow="Math.round(task.progress * 100)" aria-valuemin="0" aria-valuemax="100">
      <span :style="{ width: task.progress * 100 + '%' }"></span>
    </div>
  </article>
</template>

<style scoped>
.item {
  position: relative;
  padding: 14px 0;
  border-bottom: 1px solid #e5eaf1;
}
.item__main {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 12px;
}
.item__icon {
  display: grid;
  width: 38px;
  height: 38px;
  place-items: center;
  border-radius: 10px;
  background: #e0f2fe;
  color: #0369a1;
  font-size: 10px;
  font-weight: 800;
}
.item__copy,
.item__result {
  display: grid;
  gap: 4px;
  min-width: 0;
}
.item__copy strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.item__copy span,
.item__result span {
  color: #64748b;
  font-size: 12px;
}
.item__result {
  min-width: 104px;
  text-align: right;
}
.item__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 5px;
}
.item__actions button {
  min-height: 34px;
  padding: 0 9px;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  background: white;
  color: #334155;
  cursor: pointer;
  font-size: 12px;
}
.item__progress {
  height: 4px;
  margin-top: 10px;
  overflow: hidden;
  border-radius: 99px;
  background: #e2e8f0;
}
.item__progress span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: #2563eb;
  transition: width 180ms ease;
}
@media (max-width: 640px) {
  .item__main {
    grid-template-columns: auto minmax(0, 1fr);
  }
  .item__result {
    grid-column: 2;
    min-width: 0;
    text-align: left;
  }
  .item__actions {
    grid-column: 1 / -1;
    justify-content: flex-start;
  }
}
</style>

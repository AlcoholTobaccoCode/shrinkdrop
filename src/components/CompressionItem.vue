<script setup lang="ts">
import { computed } from 'vue';
import type { CompressionTask } from '../core/compression/types';
import { canRetryOutputs, displayStatus, isActive, sourceFile } from '../core/workbench/model';

const props = defineProps<{ task: CompressionTask; canDownload?: boolean }>();
const emit = defineEmits<{
  cancel: [taskId: string];
  retry: [taskId: string];
  retryOutputs: [taskId: string];
  download: [taskId: string];
  replace: [taskId: string];
  copy: [taskId: string];
}>();

const shown = computed(() => displayStatus(props.task));
const file = computed(() => sourceFile(props.task));
const name = computed(() => file.value?.name ?? (props.task.source.kind === 'url' ? props.task.source.url : ''));
/** Provider 已出结果（含部分成功、保存失败） */
const hasResult = computed(() => props.task.output !== undefined);
const retryOutputsVisible = computed(() => canRetryOutputs(props.task));

function formatBytes(value: number | undefined): string {
  if (!value) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return (value / 1024 ** index).toFixed(index === 0 ? 0 : 1) + ' ' + units[index];
}

function statusText(): string {
  const task = props.task;
  switch (shown.value) {
    case 'completed': return '已完成';
    case 'partial': return '部分输出失败';
    case 'output-failed': return '已处理，保存失败（未消耗额度）';
    case 'failed': return task.error?.message ?? '处理失败';
    case 'canceled': return '已取消';
    case 'draft': return '待开始';
    case 'queued': return '排队中';
    case 'uploading': return '读取中';
    case 'processing': return '处理中';
    case 'saving': return '保存中';
    default: return '';
  }
}
</script>

<template>
  <article class="item">
    <div class="item__main">
      <div class="item__icon" aria-hidden="true">IMG</div>
      <div class="item__copy">
        <strong :title="file?.relativePath ?? name">{{ name }}</strong>
        <span>{{ formatBytes(task.originalSize) }} · {{ statusText() }}</span>
      </div>
      <div class="item__result">
        <strong v-if="hasResult">{{ formatBytes(task.compressedSize) }}</strong>
        <span v-if="hasResult">
          节省 {{ Math.max(0, 100 - ((task.compressedSize ?? task.originalSize) / task.originalSize) * 100).toFixed(1) }}%
        </span>
      </div>
      <div class="item__actions">
        <button v-if="task.status === 'draft' || isActive(task.status)" type="button" aria-label="取消压缩" @click="emit('cancel', task.id)">取消</button>
        <button v-if="shown === 'failed' || shown === 'canceled'" type="button" aria-label="重试压缩" @click="emit('retry', task.id)">重试</button>
        <button v-if="retryOutputsVisible" type="button" aria-label="只重试输出" @click="emit('retryOutputs', task.id)">重试输出</button>
        <button v-if="hasResult && shown !== 'output-failed' && canDownload" type="button" aria-label="下载压缩图片" @click="emit('download', task.id)">下载</button>
        <button v-if="hasResult && shown !== 'output-failed' && file" type="button" aria-label="覆盖原图" @click="emit('replace', task.id)">覆盖</button>
        <button v-if="hasResult && shown !== 'output-failed'" type="button" aria-label="复制图片" @click="emit('copy', task.id)">复制</button>
      </div>
    </div>
    <div v-if="isActive(task.status)" class="item__progress" role="progressbar" :aria-valuenow="Math.round(task.progress * 100)" aria-valuemin="0" aria-valuemax="100">
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

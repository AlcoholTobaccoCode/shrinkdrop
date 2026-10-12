<script setup lang="ts">
import CompressionItem from './CompressionItem.vue';
import type { CompressionTask } from '../core/compression/types';

defineProps<{ tasks: readonly CompressionTask[]; canDownload?: boolean }>();
const emit = defineEmits<{
  cancel: [taskId: string];
  retry: [taskId: string];
  retryOutputs: [taskId: string];
  download: [taskId: string];
  replace: [taskId: string];
  copy: [taskId: string];
}>();
</script>

<template>
  <section class="list" aria-live="polite">
    <CompressionItem
      v-for="task in tasks"
      :key="task.id"
      :task="task"
      :can-download="canDownload"
      @cancel="emit('cancel', $event)"
      @retry="emit('retry', $event)"
      @retry-outputs="emit('retryOutputs', $event)"
      @download="emit('download', $event)"
      @replace="emit('replace', $event)"
      @copy="emit('copy', $event)"
    />
  </section>
</template>

<style scoped>
.list {
  display: grid;
  gap: 0;
}
</style>

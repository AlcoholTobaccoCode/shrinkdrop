<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue';
import FileDropZone from './components/FileDropZone.vue';
import CompressionList from './components/CompressionList.vue';
import CompressionSummary from './components/CompressionSummary.vue';
import { calculateCompressionStats } from './core/compression/stats';
import type { CompressionTask } from './core/compression/types';
import type { FileAdapter, SourceFile } from './core/files/contracts';
import { BrowserImageProvider, WebFileAdapter } from './platform/web';
import { createPlatformAdapters, isTauriRuntime } from './platform';

const adapter = shallowRef<FileAdapter>();
const session = shallowRef<import('./core/compression/session').CompressionSession>();
const tasks = ref<CompressionTask[]>([]);
const busy = ref(false);
const notice = ref('');
const platformLabel = computed(() => (isTauriRuntime() ? 'Tauri 桌面端' : 'Web'));
const stats = computed(() => calculateCompressionStats(tasks.value));
const canDownload = computed(() => adapter.value instanceof WebFileAdapter);

onMounted(async () => {
  try {
    adapter.value = await createPlatformAdapters();
  } catch (error) {
    notice.value = error instanceof Error ? error.message : '平台能力加载失败';
  }
});

onUnmounted(() => {
  if (session.value) void session.value.cleanup(session.value.sessionId);
});

async function chooseFiles(): Promise<void> {
  await select(async current => current.chooseFiles());
}

async function chooseDirectory(): Promise<void> {
  await select(async current => current.chooseDirectory());
}

async function select(read: (current: FileAdapter) => Promise<SourceFile[]>): Promise<void> {
  if (!adapter.value || busy.value) return;
  notice.value = '';
  try {
    const files = await read(adapter.value);
    await startSession(files);
  } catch (error) {
    notice.value = error instanceof Error ? error.message : '选择文件失败';
  }
}

async function handleDrop(files: File[]): Promise<void> {
  const webAdapter = adapter.value instanceof WebFileAdapter ? adapter.value : undefined;
  if (!webAdapter || busy.value) {
    notice.value = '桌面端请使用系统文件选择器导入图片';
    return;
  }
  await startSession(webAdapter.fromFiles(files));
}

async function startSession(files: readonly SourceFile[]): Promise<void> {
  if (!adapter.value) return;
  if (files.length === 0) {
    notice.value = '没有找到支持的 PNG、JPG、JPEG 或 WebP 图片';
    return;
  }

  if (session.value && !busy.value) {
    session.value.addFiles(files);
    busy.value = true;
    try {
      await session.value.run();
    } finally {
      busy.value = false;
    }
    return;
  }

  const nextSession = new (await import('./core/compression/session')).CompressionSession({
    adapter: adapter.value,
    provider: new BrowserImageProvider(),
    onUpdate: nextTasks => {
      tasks.value = nextTasks.map(task => ({ ...task, error: task.error ? { ...task.error } : undefined }));
    }
  });
  nextSession.addFiles(files);
  session.value = nextSession;
  tasks.value = nextSession.tasks.slice();
  busy.value = true;
  try {
    await nextSession.run();
  } finally {
    busy.value = false;
  }
}

function taskById(taskId: string): CompressionTask | undefined {
  return tasks.value.find(task => task.id === taskId);
}

function cancel(taskId: string): void {
  session.value?.cancel(taskId);
}

function cancelAll(): void {
  session.value?.cancelAll();
}

async function retry(taskId: string): Promise<void> {
  if (!session.value) return;
  busy.value = true;
  try {
    await session.value.retry(taskId);
  } finally {
    busy.value = false;
  }
}

function download(taskId: string): void {
  const task = taskById(taskId);
  const webAdapter = adapter.value instanceof WebFileAdapter ? adapter.value : undefined;
  if (!task?.tempFile || !webAdapter) return;
  try {
    webAdapter.download(task.tempFile);
  } catch (error) {
    notice.value = error instanceof Error ? error.message : '下载失败';
  }
}

async function replace(taskId: string): Promise<void> {
  const task = taskById(taskId);
  if (!task?.tempFile || !adapter.value) return;
  if (!window.confirm('覆盖原图后无法撤销，确定继续吗？')) return;
  try {
    await adapter.value.replaceOriginal(task.tempFile, task.source);
    notice.value = '原图覆盖成功';
  } catch (error) {
    notice.value = error instanceof Error ? error.message : '覆盖原图失败';
  }
}

async function copy(taskId: string): Promise<void> {
  const task = taskById(taskId);
  if (!task?.tempFile || !adapter.value) return;
  try {
    await adapter.value.copyToClipboard([task.tempFile]);
    notice.value = '已复制到剪贴板';
  } catch (error) {
    notice.value = error instanceof Error ? error.message : '复制失败';
  }
}

function clear(): void {
  if (busy.value) return;
  const current = session.value;
  tasks.value = [];
  session.value = undefined;
  if (current) void current.cleanup(current.sessionId);
}

</script>

<template>
  <main class="app-shell">
    <header class="topbar">
      <div>
        <p class="eyebrow">LOCAL IMAGE TOOL</p>
        <h1>图片压缩</h1>
      </div>
      <span class="platform">{{ platformLabel }}</span>
    </header>

    <p v-if="notice" class="notice" role="status">{{ notice }}</p>

    <FileDropZone v-if="!tasks.length" :busy="busy" @choose-files="chooseFiles" @choose-directory="chooseDirectory" @drop-files="handleDrop" />

    <section v-else class="workspace">
      <div class="workspace__heading">
        <div>
          <h2>压缩队列</h2>
          <p>{{ stats.total }} 张图片 · {{ Math.round(stats.progress * 100) }}% 完成</p>
        </div>
        <button type="button" class="secondary" :disabled="busy" @click="chooseFiles">继续添加</button>
      </div>
      <CompressionList
        :tasks="tasks"
        :can-download="canDownload"
        @cancel="cancel"
        @retry="retry"
        @download="download"
        @replace="replace"
        @copy="copy"
      />
      <CompressionSummary :stats="stats" @clear="clear" @cancel-all="cancelAll" />
    </section>
  </main>
</template>

<style scoped>
.app-shell {
  width: min(1040px, 100%);
  min-height: 100vh;
  margin: 0 auto;
  padding: 28px clamp(18px, 5vw, 64px) 44px;
}
.topbar {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 28px;
}
.eyebrow {
  margin: 0 0 8px;
  color: #2563eb;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: .14em;
}
h1,
h2 {
  margin: 0;
  color: #172033;
}
h1 {
  font-size: clamp(28px, 5vw, 42px);
  letter-spacing: -.04em;
}
.platform {
  padding: 8px 11px;
  border: 1px solid #dbe3ef;
  border-radius: 99px;
  background: #fff;
  color: #64748b;
  font-size: 12px;
}
.notice {
  margin: 0 0 16px;
  padding: 12px 14px;
  border-radius: 12px;
  background: #fff7ed;
  color: #9a3412;
}
.workspace {
  padding: 22px 24px 18px;
  border: 1px solid #dbe3ef;
  border-radius: 22px;
  background: #fff;
  box-shadow: 0 18px 50px rgb(15 23 42 / 6%);
}
.workspace__heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  margin-bottom: 8px;
}
.workspace__heading p {
  margin: 5px 0 0;
  color: #64748b;
  font-size: 13px;
}
button.secondary {
  min-height: 40px;
  padding: 0 14px;
  border: 1px solid #cbd5e1;
  border-radius: 10px;
  background: white;
  color: #334155;
  cursor: pointer;
}
button:disabled {
  cursor: not-allowed;
  opacity: .5;
}
@media (max-width: 640px) {
  .workspace {
    padding: 16px;
  }
  .workspace__heading {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>

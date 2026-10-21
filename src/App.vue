<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import LiteIcon from './components/LiteIcon.vue';
import { createLiteSession } from './core/lite/session';
import { formatBytes, sizeChange, statusLabel } from './core/lite/presentation';
import { createLiteAdapter } from './platform';
import { connectDesktopEvents } from './platform/native';
import { fromBrowserFiles } from './platform/web';

//#region 页面会话与交互
const adapter = createLiteAdapter();
const desktop = adapter.desktop;
const session = createLiteSession(adapter);
const { state, summary } = session;
const dragging = ref(false);
const filePickingDisabled = computed(() => state.importing || state.clearing);
const startDisabled = computed(() => !desktop || !summary.value.draft || state.clearing);
const saveDisabled = computed(() => !desktop || !summary.value.completed || summary.value.saving || state.clearing);
const overwriteDisabled = computed(() => !desktop || !summary.value.overwritable || summary.value.saving || state.clearing);
const totalChange = computed(() => {
  const difference = summary.value.savedBytes;
  if (!summary.value.completed) return '';
  if (!difference) return '大小不变';
  return `共${difference > 0 ? '减少' : '增加'} ${formatBytes(Math.abs(difference))}`;
});

function onDragOver(event: DragEvent) {
  event.preventDefault();
  if (!desktop) dragging.value = true;
}
function onDragLeave(event: DragEvent) {
  const related = event.relatedTarget;
  if (!desktop && event.currentTarget instanceof Node
    && !(related instanceof Node && event.currentTarget.contains(related))) dragging.value = false;
}
async function onDrop(event: DragEvent) {
  event.preventDefault(); dragging.value = false;
  if (!desktop) await session.importSources(fromBrowserFiles(Array.from(event.dataTransfer?.files ?? [])));
}
let detached = () => {};
let unmounted = false;
onMounted(async () => {
  if (!desktop) return;
  try {
    const stop = await connectDesktopEvents({
      imported: files => { dragging.value = false; void session.importSources(files, { reportEmpty: true }); },
      progress: session.updateProgress,
      drag: active => { dragging.value = active; }
    });
    if (unmounted) stop(); else detached = stop;
  } catch { session.notify('拖放暂时不可用，请使用「添加图片」选择文件。', 'error'); }
});
onBeforeUnmount(() => { unmounted = true; detached(); void session.dispose(); });
//#endregion
</script>

<template>
  <main class="app-shell" @dragover="onDragOver" @dragleave="onDragLeave" @drop="onDrop">
    <header class="toolbar">
      <div class="brand">
        <span class="brand-mark"><LiteIcon name="image" /></span>
        <h1>TinyPNG <span>Lite</span></h1>
      </div>
      <div class="import-actions">
        <button class="auto-switch" role="switch" :aria-checked="state.autoCompress"
          :disabled="!desktop || state.clearing" aria-label="上传自动压缩"
          :title="state.autoCompress ? '开启后，添加图片就会自动上传压缩' : '关闭时，添加后需手动开始压缩'"
          @click="session.setAutoCompress(!state.autoCompress)">
          <span>上传自动压缩</span><span class="switch-track" aria-hidden="true"><span /></span>
        </button>
        <button class="button" :disabled="filePickingDisabled" @click="session.choose('files')">
          <LiteIcon name="plus" />添加图片
        </button>
        <button class="button" :disabled="filePickingDisabled" @click="session.choose('directory')">
          <LiteIcon name="folder" />添加文件夹
        </button>
      </div>
    </header>

    <p v-if="!desktop" class="preview-banner" role="note">当前为浏览器预览。压缩和保存图片请使用桌面版。</p>
    <div v-if="state.notice" class="notice" :class="`notice--${state.noticeKind}`" role="status" aria-live="polite">
      <span>{{ state.notice }}</span>
      <button class="icon-button" aria-label="关闭提示" @click="state.notice = ''"><LiteIcon name="close" /></button>
    </div>

    <section class="workspace" aria-label="图片列表">
      <button
        v-if="!state.items.length" class="drop-zone drop-zone--empty" :class="{ 'is-dragging': dragging }"
        :disabled="filePickingDisabled" @click="session.choose('files')"
      >
        <span class="drop-icon"><LiteIcon name="upload" /></span>
        <strong>{{ dragging ? '松手即可添加' : desktop ? '拖入图片或文件夹' : '拖入图片，或点击添加' }}</strong>
        <span>PNG、JPEG、WebP · 单张不超过 20 MB</span>
        <span class="empty-hint">{{ state.autoCompress ? '自动压缩已开启，添加后立即上传处理' : '添加后，点击「开始压缩」' }}</span>
      </button>
      <template v-else>
        <button class="drop-zone drop-zone--compact" :class="{ 'is-dragging': dragging }" :disabled="filePickingDisabled" @click="session.choose('files')">
          <LiteIcon name="plus" /><span>{{ dragging ? '松手即可添加' : '拖入更多图片或文件夹' }}</span>
          <span class="drop-limit">单张 ≤ 20 MB</span>
        </button>
        <div class="list-heading" aria-hidden="true"><span>图片</span><span>原始大小</span><span>压缩后</span><span>变化</span><span>操作</span></div>
        <ul class="image-list" aria-label="待压缩图片">
          <li v-for="item in state.items" :key="item.id" class="image-row"
            :class="{ 'image-row--error': item.status === 'failed' || item.saveError || item.overwriteError,
              'image-row--busy': item.status === 'processing', 'image-row--stopped': item.status === 'canceled' }"
            :style="{ '--item-progress': `${item.progress * 100}%` }">
            <div v-if="item.status !== 'draft'" class="row-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100"
              :aria-valuenow="item.status === 'completed' ? 100 : undefined"
              :aria-label="`${item.source.name} 压缩进度`" :aria-valuetext="statusLabel(item)" />
            <div class="file-info">
              <span class="thumbnail">
                <img v-if="item.thumbnailUrl && !item.thumbnailFailed" :src="item.thumbnailUrl" alt="" loading="lazy" decoding="async" @error="item.thumbnailFailed = true" />
                <LiteIcon v-else name="image" />
              </span>
              <div class="file-copy">
                <p class="file-name" :title="item.source.relativePath || item.source.name">{{ item.source.name }}</p>
                <p class="file-status" :class="`file-status--${item.status}`" aria-live="polite">
                  <span v-if="item.status === 'processing' || item.status === 'queued'" class="status-dot" :class="{ 'status-dot--busy': item.status === 'processing' }" />
                  <LiteIcon v-if="item.status === 'completed'" name="check" />{{ statusLabel(item) }}
                </p>
              </div>
            </div>
            <span class="file-size"><span class="mobile-label">原始</span>{{ formatBytes(item.source.size) }}</span>
            <span class="file-size"><span class="mobile-label">压缩后</span>{{ item.result ? formatBytes(item.result.size) : '—' }}</span>
            <span class="file-change" :class="item.result ? `file-change--${sizeChange(item.source.size, item.result.size).tone}` : ''">
              {{ item.result ? sizeChange(item.source.size, item.result.size).text : '—' }}
            </span>
            <div class="row-actions">
              <button v-if="item.status === 'queued' || item.status === 'processing'" class="row-button" :disabled="item.cancelPending || state.clearing" :aria-label="`取消 ${item.source.name}`" @click="session.cancel(item.id)">取消</button>
              <button v-else-if="item.status === 'failed' || item.status === 'canceled'" class="row-button" :disabled="!desktop || state.clearing" :aria-label="`重试 ${item.source.name}`" @click="session.retry(item.id)"><LiteIcon name="retry" />重试</button>
              <button v-if="item.status === 'completed'" class="row-button row-button--save" :disabled="!desktop || summary.saving || state.clearing" :aria-label="`${item.saveError ? '重试保存' : '保存'} ${item.source.name}`" @click="session.save(item.id)">
                <LiteIcon name="download" />{{ item.saving ? '保存中' : item.saveError ? '重试保存' : '保存' }}
              </button>
              <button v-if="item.status === 'completed'" class="row-button row-button--overwrite"
                :disabled="!desktop || summary.saving || state.clearing || item.overwritten"
                :aria-label="`${item.overwritten ? '已覆盖' : item.overwriteError ? '重试覆盖' : '覆盖'} ${item.source.name}`"
                :title="item.overwritten ? '已用压缩结果覆盖原图' : '确认后用压缩结果替换原图'"
                @click="session.overwrite(item.id)"><LiteIcon name="replace" />{{ item.overwriting ? '覆盖中' : item.overwritten ? '已覆盖' : '覆盖' }}</button>
              <button v-if="item.status !== 'queued' && item.status !== 'processing'" class="icon-button remove-button" :disabled="summary.saving || state.clearing" :aria-label="`移除 ${item.source.name}`" @click="session.remove(item.id)"><LiteIcon name="close" /></button>
            </div>
            <p v-if="item.error || item.cancelError || item.saveError || item.overwriteError" class="row-error" role="status">{{ item.overwriteError || item.saveError || item.error || item.cancelError }}</p>
          </li>
        </ul>
      </template>
    </section>

    <p class="privacy-note">图片会上传至 TinyPNG 进行压缩；除非手动覆盖，原图不会被修改。</p>
    <footer class="footer">
      <div class="summary" aria-live="polite">
        <p><strong>{{ summary.count }} 张图片</strong><span v-if="summary.count">{{ formatBytes(summary.originalBytes) }}</span></p>
        <p class="summary-detail">
          <template v-if="summary.completed || summary.active || summary.failed || summary.canceled">
            <span v-if="summary.completed">{{ summary.completed }} 张完成</span>
            <span v-if="summary.active">{{ summary.active }} 张进行中</span>
            <span v-if="summary.failed">{{ summary.failed }} 张失败</span>
            <span v-if="summary.canceled">{{ summary.canceled }} 张取消</span>
          </template>
          <span v-else>{{ summary.count ? '准备好了，点击开始压缩' : state.autoCompress ? '添加图片后自动上传压缩' : '添加图片，开始轻装' }}</span>
          <span v-if="totalChange" :class="summary.savedBytes < 0 ? 'increased' : 'saved-space'">{{ totalChange }}</span>
        </p>
      </div>
      <div class="footer-actions">
        <button class="button button--quiet" :disabled="!summary.count || summary.saving || state.clearing" @click="session.clear()">{{ state.clearing ? '正在清空' : '清空' }}</button>
        <button class="button" :disabled="saveDisabled" @click="session.saveAll()"><LiteIcon name="download" />{{ state.bulkSaving ? '保存中' : '保存全部' }}</button>
        <button class="button button--overwrite" :disabled="overwriteDisabled" @click="session.overwriteAll()"><LiteIcon name="replace" />{{ state.bulkOverwriting ? '覆盖中' : '批量覆盖' }}</button>
        <button class="button button--primary" :disabled="startDisabled" @click="session.start()">{{ summary.active && !summary.draft ? '正在压缩' : '开始压缩' }}<span v-if="summary.draft">{{ summary.draft }}</span></button>
      </div>
    </footer>
  </main>
</template>

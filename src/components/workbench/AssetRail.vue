<script setup lang="ts">
import { ref } from 'vue';
import type { QueueItemView } from '../../core/workbench/queue-view';
import type { WorkbenchItem } from '../../core/workbench/model';
import { formatBytes } from '../../core/ui/compare';

defineProps<{
  rows: ReadonlyArray<{ item: WorkbenchItem; view: QueueItemView }>;
  selectedId?: string;
  canAddUrls: boolean;
  thumbs: Record<string, string>;
  horizontal?: boolean;
}>();
const emit = defineEmits<{ addFiles: []; addUrls: [urls: string[]]; select: [id: string]; drop: [files: File[]] }>();
const urlOpen = ref(false);
const urlText = ref('');
const dragging = ref(false);

function submitUrls(): void {
  const urls = urlText.value.split(/\s+/).map(s => s.trim()).filter(Boolean);
  if (urls.length) emit('addUrls', urls);
  urlText.value = '';
  urlOpen.value = false;
}
function host(text: string): string {
  try { return new URL(text.split(/\s+/)[0] ?? '').host; } catch { return ''; }
}
function name(item: WorkbenchItem): string {
  return item.source.kind === 'file' ? item.source.file.name : item.source.url.split('/').pop() || item.source.url;
}
const stateText: Record<QueueItemView['state'], string> = { draft: '草稿', queued: '排队中', running: '处理中', completed: '已完成', partial: '部分成功', 'output-failed': '保存失败', failed: '失败', canceled: '已取消' };
function onDrop(e: DragEvent): void {
  dragging.value = false;
  const files = Array.from(e.dataTransfer?.files ?? []);
  if (files.length) emit('drop', files);
}
</script>

<template>
  <nav class="rail" :class="{ 'rail--h': horizontal, 'rail--drag': dragging }" aria-label="素材" @dragover.prevent="dragging = true" @dragleave="dragging = false" @drop.prevent="onDrop">
    <h3 v-if="!horizontal">素材 <span class="muted">{{ rows.length }} 张</span></h3>
    <div class="adds">
      <button type="button" class="btn" :aria-label="horizontal ? '添加图片' : undefined" @click="emit('addFiles')">＋<template v-if="!horizontal"> 添加图片</template></button>
      <button v-if="canAddUrls" type="button" class="btn" :aria-label="horizontal ? '添加 URL' : undefined" :aria-expanded="urlOpen" @click="urlOpen = !urlOpen">🔗<template v-if="!horizontal"> 添加 URL</template></button>
    </div>
    <form v-if="urlOpen && canAddUrls" class="url" @submit.prevent="submitUrls">
      <label for="url-input">图片 URL（每行一个）</label>
      <textarea id="url-input" v-model="urlText" rows="3" placeholder="https://example.com/a.png" />
      <p v-if="host(urlText)" class="muted small">将由 Server 获取：<span class="mono">{{ host(urlText) }}</span></p>
      <button type="submit" class="btn btn--sm">加入草稿</button>
    </form>
    <ul class="assets">
      <li v-for="r in rows" :key="r.item.id">
        <button type="button" class="asset" :class="{ 'asset--sel': r.item.id === selectedId }" :aria-current="r.item.id === selectedId ? 'true' : undefined" :aria-label="name(r.item) + ' · ' + stateText[r.view.state]" @click="emit('select', r.item.id)">
          <span class="thumb checker"><img v-if="thumbs[r.item.id]" :src="thumbs[r.item.id]" alt=""><span class="dot" :class="'dot--' + r.view.state" aria-hidden="true" /></span>
          <span v-if="!horizontal" class="meta">
            <span class="n">{{ name(r.item) }}</span>
            <span class="m num">{{ formatBytes(r.item.originalSize) }} · {{ stateText[r.view.state] }}</span>
          </span>
        </button>
      </li>
    </ul>
  </nav>
</template>

<style scoped>
.rail { display: flex; flex-direction: column; gap: var(--s-3); height: 100%; min-height: 0; padding: var(--s-4); background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg); overflow: hidden; }
.rail--drag { outline: 2px dashed var(--focus); outline-offset: -6px; }
.rail--h { flex-direction: row; align-items: center; height: auto; padding: 8px; overflow-x: auto; }
h3 { margin: 0; font-size: 14px; line-height: 18px; font-weight: 600; }
.muted { color: var(--ink-muted); font-weight: 400; }
.small { font-size: 12px; margin: 0; }
.adds { display: flex; gap: 8px; flex-shrink: 0; }
.url { display: flex; flex-direction: column; gap: 6px; font-size: 13px; }
textarea { padding: 6px 8px; border: 1px solid var(--line-strong); border-radius: var(--r-sm); background: var(--surface-sunken); color: var(--ink); font-family: var(--font-mono); font-size: 12px; resize: vertical; }
.assets { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; overflow: auto; list-style: none; min-height: 0; }
.rail--h .assets { flex-direction: row; overflow: visible; }
.asset { display: flex; align-items: center; gap: 10px; width: 100%; padding: 6px; border: 1px solid transparent; border-radius: var(--r-md); background: none; color: var(--ink); text-align: left; cursor: pointer; }
.asset:hover { background: var(--surface-sunken); }
.asset--sel { border-color: var(--line-strong); background: var(--surface-sunken); }
.thumb { position: relative; flex-shrink: 0; width: 44px; height: 44px; border-radius: var(--r-sm); overflow: hidden; }
.thumb img { width: 100%; height: 100%; object-fit: cover; }
.dot { position: absolute; right: 3px; bottom: 3px; width: 9px; height: 9px; border-radius: 50%; border: 1.5px solid var(--surface); background: var(--ink-faint); }
.dot--running, .dot--queued { background: var(--info); }
.dot--completed { background: var(--success); }
.dot--partial, .dot--output-failed { background: var(--warning); }
.dot--failed { background: var(--danger); }
.meta { display: flex; flex-direction: column; min-width: 0; }
.n { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.m { color: var(--ink-muted); font-size: 12px; }
.mono { font-family: var(--font-mono); }
.btn { height: 32px; padding: 0 12px; border: 1px solid var(--line-strong); border-radius: var(--r-md); background: var(--surface); color: var(--ink); cursor: pointer; white-space: nowrap; }
.btn--sm { height: 28px; align-self: flex-start; }
</style>

<script setup lang="ts">
import { computed } from 'vue';
import { CollapsibleContent, CollapsibleRoot, CollapsibleTrigger } from 'reka-ui';
import { sizeChangeLabel, type QueueAction, type QueueItemView } from '../../core/workbench/queue-view';
import type { WorkbenchItem } from '../../core/workbench/model';
import type { RejectedFile } from '../../stores/workbench';
import { formatBytes } from '../../core/ui/compare';
import QueueRow from './QueueRow.vue';

const props = defineProps<{
  rows: ReadonlyArray<{ item: WorkbenchItem; view: QueueItemView }>;
  rejected: readonly RejectedFile[];
  selectedId?: string;
  providerLabel?: string;
  narrow?: boolean;
  hasRunning: boolean;
  onAction: (action: QueueAction, id: string) => unknown;
  downloadCount: number;
  archiveBusy?: boolean;
  archiveError?: string;
}>();
const emit = defineEmits<{ select: [id: string]; cancelAll: []; dismissRejected: [index: number]; downloadArchive: []; cancelArchive: []; clear: [] }>();
const open = defineModel<boolean>('open', { default: true });

const counts = computed(() => {
  const c: Record<string, number> = {};
  for (const r of props.rows) c[r.view.state] = (c[r.view.state] ?? 0) + 1;
  return c;
});
const summary = computed(() => {
  const c = counts.value;
  const parts = [
    c.draft && '草稿 ' + c.draft,
    c.queued && '排队 ' + c.queued,
    c.running && '运行 ' + c.running,
    c.completed && '成功 ' + c.completed,
    c.partial && '部分成功 ' + c.partial,
    c['output-failed'] && '保存失败 ' + c['output-failed'],
    c.failed && '失败 ' + c.failed,
    c.canceled && '已取消 ' + c.canceled
  ].filter(Boolean);
  const total = props.rows.reduce((s, r) => s + r.item.originalSize, 0);
  const processed = props.rows.filter(row => row.item.output && row.item.compressedSize !== undefined);
  const original = processed.reduce((sum, row) => sum + row.item.originalSize, 0);
  const results = processed.reduce((sum, row) => sum + (row.item.compressedSize ?? 0), 0);
  const resultSummary = processed.length ? ' · 结果 ' + formatBytes(results) + ' · ' + sizeChangeLabel(original, results) : '';
  return parts.length ? parts.join(' · ') + ' · 原始总计 ' + formatBytes(total) + resultSummary : '暂无任务';
});
/** 读屏汇总（不播每个百分比） */
const live = computed(() => {
  const c = counts.value;
  const done = (c.completed ?? 0) + (c.partial ?? 0);
  const bad = (c.failed ?? 0) + (c['output-failed'] ?? 0);
  return done || bad ? done + ' 张完成' + (bad ? '，' + bad + ' 张失败' : '') : '';
});
</script>

<template>
  <section class="queue" :class="{ 'queue--narrow': narrow }" aria-label="任务队列">
    <CollapsibleRoot v-model:open="open" :disabled="!narrow">
      <header class="head">
        <b>任务队列</b>
        <span class="summary num">{{ summary }}</span>
        <span class="spacer" />
        <button v-if="hasRunning" type="button" class="btn btn--sm btn--danger" @click="emit('cancelAll')">取消全部</button>
        <button v-if="rows.length && !hasRunning" type="button" class="btn btn--sm" :disabled="archiveBusy" @click="emit('clear')">清空任务</button>
        <button type="button" class="btn btn--sm" :disabled="!downloadCount || archiveBusy" :title="downloadCount ? '只包含已生成的成功结果' : '还没有成功的结果'" @click="emit('downloadArchive')">{{ archiveBusy ? '正在打包…' : '⇩ 全部下载 (zip)' }}</button>
        <button v-if="archiveBusy" type="button" class="btn btn--sm" @click="emit('cancelArchive')">取消打包</button>
        <CollapsibleTrigger v-if="narrow" class="btn btn--sm" :aria-label="open ? '收起任务队列' : '展开任务队列'">{{ open ? '▾' : '▴' }}</CollapsibleTrigger>
      </header>
      <p v-if="downloadCount || archiveError" class="download-note" :class="{ 'download-note--error': archiveError }" :role="archiveError ? 'alert' : 'status'">{{ archiveError ? 'zip 下载失败：' + archiveError + '。请重试。' : '含 ' + downloadCount + ' 张成功结果，其余任务未包含' }}</p>
      <CollapsibleContent force-mount :hidden="narrow && !open ? true : undefined">
        <ul class="list">
          <li v-for="(r, i) in rejected" :key="'rej' + i" class="rejected">
            <span class="icon" aria-hidden="true">✕</span><span class="mono">{{ r.name }}</span><span>{{ r.reason }}</span>
            <button type="button" class="btn btn--sm" :aria-label="'关闭提示 ' + r.name" @click="emit('dismissRejected', i)">关闭</button>
          </li>
          <QueueRow
            v-for="r in rows"
            :key="r.item.id"
            :item="r.item"
            :view="r.view"
            :selected="r.item.id === selectedId"
            :provider-label="providerLabel"
            :on-action="onAction"
            @select="emit('select', $event)"
          />
          <li v-if="!rows.length && !rejected.length" class="empty">添加图片后会出现在这里，点击「开始处理」才会执行</li>
        </ul>
      </CollapsibleContent>
    </CollapsibleRoot>
    <p class="sr-only" aria-live="polite">{{ live }}</p>
  </section>
</template>

<style scoped>
.queue { display: flex; flex-direction: column; min-height: 0; height: 100%; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg); overflow: hidden; }
.queue > div { display: flex; flex-direction: column; min-height: 0; height: 100%; }
.head { display: flex; align-items: center; gap: var(--s-3); padding: 8px var(--s-4); border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.summary { color: var(--ink-muted); font-size: 12px; }
.download-note { margin: 0; padding: 4px 16px; color: var(--ink-muted); font-size: 12px; overflow-wrap: anywhere; }
.download-note--error { color: var(--danger); }
.spacer { flex: 1; }
.list { margin: 0; padding: 4px 8px; overflow: auto; flex: 1; min-height: 0; }
.queue--narrow .list { max-height: 132px; }
.rejected { display: grid; grid-template-columns: 20px auto 1fr auto; align-items: center; gap: 10px; padding: 6px 8px; color: var(--danger); font-size: 13px; list-style: none; }
.empty { padding: 20px; text-align: center; color: var(--ink-muted); list-style: none; }
.icon { text-align: center; }
.mono { font-family: var(--font-mono); }
.btn { height: 28px; padding: 0 10px; border: 1px solid var(--line-strong); border-radius: var(--r-md); background: var(--surface); color: var(--ink); cursor: pointer; font-size: 13px; }
.btn--danger { color: var(--danger); border-color: var(--danger); }
.btn:disabled { opacity: .45; cursor: not-allowed; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
</style>

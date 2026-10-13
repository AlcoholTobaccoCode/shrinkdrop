<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { CollapsibleContent, CollapsibleRoot, CollapsibleTrigger } from 'reka-ui';
import type { QueueAction, QueueItemView } from '../../core/workbench/queue-view';
import type { WorkbenchItem } from '../../core/workbench/model';
import { formatBytes } from '../../core/ui/compare';

const props = defineProps<{
  item: WorkbenchItem;
  view: QueueItemView;
  selected?: boolean;
  providerLabel?: string;
  /** 执行动作；返回 Promise 时按钮显示 spinner，失败在行下方提示 */
  onAction: (action: QueueAction, id: string) => unknown;
}>();
const emit = defineEmits<{ select: [id: string] }>();

const name = computed(() => (props.item.source.kind === 'file' ? props.item.source.file.name : new URL(props.item.source.url).host));
const busy = ref<QueueAction>();
const canceling = ref(false);
watch(() => props.view.state, state => { if (['completed', 'failed', 'canceled', 'partial', 'output-failed'].includes(state)) canceling.value = false; });
const error = ref('');
const labels: Record<QueueAction, string> = { remove: '移除', cancel: '取消', retry: '重试', 'retry-outputs': '重试输出', download: '下载' };
const icons: Record<QueueItemView['state'], string> = { draft: '○', queued: '◷', running: '●', completed: '✓', partial: '✓!', 'output-failed': '!', failed: '✕', canceled: '⊘' };
const text = computed(() => {
  if (canceling.value && props.view.state !== 'canceled') return '取消中…';
  if (props.view.state === 'completed' && props.item.compressedSize !== undefined) {
    return (props.item.originalSize ? formatBytes(props.item.originalSize) : '原始体积未知') + ' → ' + formatBytes(props.item.compressedSize) + ' · ' + props.view.text;
  }
  return props.view.text;
});

async function run(action: QueueAction): Promise<void> {
  if (busy.value) return;
  error.value = '';
  busy.value = action;
  if (action === 'cancel') canceling.value = true;
  try {
    await props.onAction(action, props.item.id);
  } catch (e) {
    error.value = (e instanceof Error ? e.message : '操作失败') + '，请重试';
    canceling.value = false;
  } finally {
    busy.value = undefined;
  }
}
/** 行内 ←/→ 在操作间移动（roving），↑/↓ 跨行，Delete 移除草稿 */
function onKey(e: KeyboardEvent): void {
  const row = (e.currentTarget as HTMLElement);
  const buttons = Array.from(row.querySelectorAll<HTMLButtonElement>('[data-roving]:not(:disabled)'));
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    if (index < 0) return;
    const next = buttons[(index + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length];
    next?.focus();
    e.preventDefault();
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const sibling = (e.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling) as HTMLElement | null;
    const target = sibling?.querySelectorAll<HTMLButtonElement>('[data-roving]:not(:disabled)')[Math.max(0, index)] ?? sibling?.querySelector<HTMLButtonElement>('[data-roving]');
    if (target) { target.focus(); e.preventDefault(); }
  } else if (e.key === 'Delete' && props.view.state === 'draft') {
    void run('remove');
    e.preventDefault();
  }
}
</script>

<template>
  <li class="row" :class="['row--' + view.state, { 'row--selected': selected }]" @keydown="onKey">
    <CollapsibleRoot v-slot="{ open }">
      <div class="row__main">
        <span class="icon" :class="'icon--' + view.state" aria-hidden="true">{{ icons[view.state] }}</span>
        <button type="button" class="name" data-roving :tabindex="-1" :aria-current="selected ? 'true' : undefined" @click="emit('select', item.id)">{{ name }}</button>
        <span class="text num">{{ text }}<span v-if="view.note" class="note"> · {{ view.note }}</span></span>
        <span class="actions">
          <button
            v-for="(action, i) in view.actions"
            :key="action"
            type="button"
            class="btn btn--sm"
            data-roving
            :tabindex="i === 0 ? 0 : -1"
            :disabled="busy !== undefined || (action === 'cancel' && canceling)"
            :aria-label="labels[action] + ' ' + name"
            @click="run(action)"
          ><span v-if="busy === action" class="spinner" aria-hidden="true" />{{ labels[action] }}</button>
          <CollapsibleTrigger class="btn btn--sm btn--icon" data-roving :tabindex="-1" :aria-label="(open ? '收起' : '展开') + '详情 ' + name">{{ open ? '▴' : '▾' }}</CollapsibleTrigger>
        </span>
      </div>
      <div v-if="view.progress !== undefined" class="bar" role="progressbar" :aria-valuenow="Math.round(view.progress * 100)" aria-valuemin="0" aria-valuemax="100" :aria-valuetext="view.text">
        <span :style="{ transform: 'scaleX(' + view.progress + ')' }" />
      </div>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p v-else-if="item.status === 'draft' && item.error" class="error" role="status">{{ item.error.message }}</p>
      <CollapsibleContent class="details">
        <dl>
          <dt>来源</dt><dd class="mono">{{ item.source.kind === 'file' ? item.source.file.relativePath : item.source.url }}</dd>
          <dt>Provider</dt><dd>{{ providerLabel ?? (item.mode === 'private-local' ? '本地 Canvas' : '') }}</dd>
          <dt>尝试次数</dt><dd class="num">{{ item.attempts }}</dd>
          <template v-for="o in item.outputs" :key="o.outputId">
            <dt>输出 · {{ o.destination.type === 'download' ? '下载' : o.destination.type }}</dt>
            <dd>{{ { pending: '等待', saving: '保存中', completed: '已保存', failed: '失败' }[o.status] }}<template v-if="o.error"> · {{ o.error.message }}</template></dd>
          </template>
          <template v-if="item.error"><dt>错误</dt><dd>{{ item.error.code }} · {{ item.error.message }}</dd></template>
        </dl>
      </CollapsibleContent>
    </CollapsibleRoot>
  </li>
</template>

<style scoped>
.row { padding: 6px 8px; border-radius: var(--r-md); list-style: none; }
.row:hover { background: var(--surface-sunken); }
.row--selected { background: var(--surface-sunken); }
.row--canceled { opacity: .7; }
.row__main { display: grid; grid-template-columns: 20px minmax(80px, 1.2fr) minmax(0, 2fr) auto; align-items: center; gap: 10px; }
.icon { text-align: center; font-size: 12px; font-weight: 700; color: var(--ink-muted); transition: opacity 120ms; }
.icon--running { color: var(--info); animation: breathe 1.2s ease-in-out infinite; }
.icon--completed { color: var(--success); }
.icon--partial, .icon--output-failed { color: var(--warning); }
.icon--failed { color: var(--danger); }
.icon--canceled { color: var(--ink-faint); }
.name { border: 0; background: none; padding: 0; text-align: left; color: var(--ink); font-weight: 500; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-family: var(--font-mono); font-size: 13px; }
.text { color: var(--ink-muted); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.row--failed .text { color: var(--danger); }
.row--output-failed .text, .row--partial .text { color: var(--warning); }
.note { color: var(--ink-muted); }
.actions { display: flex; gap: 4px; }
.btn { display: inline-flex; align-items: center; gap: 4px; height: 28px; padding: 0 10px; border: 1px solid var(--line-strong); border-radius: var(--r-md); background: var(--surface); color: var(--ink); cursor: pointer; font-size: 13px; }
.btn--icon { width: 28px; padding: 0; justify-content: center; }
.btn:disabled { opacity: .45; cursor: not-allowed; }
.bar { height: 3px; margin: 6px 0 0 30px; background: var(--surface-sunken); border-radius: 2px; overflow: hidden; }
.bar span { display: block; height: 100%; background: var(--info); transform-origin: 0 50%; transition: transform 200ms linear; }
.error { margin: 4px 0 0 30px; color: var(--danger); font-size: 12px; }
.details dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 8px 0 4px 30px; font-size: 12px; color: var(--ink-muted); }
.details dd { margin: 0; color: var(--ink); overflow-wrap: anywhere; }
.mono { font-family: var(--font-mono); }
.spinner { width: 10px; height: 10px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin .8s linear infinite; }
@keyframes breathe { 50% { opacity: .35; } }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .icon--running, .spinner { animation: none; } .bar span { transition: none; } }
@media (max-width: 1023px) { .row__main { grid-template-columns: 20px minmax(0, 1fr) auto; } .text { grid-column: 2 / 4; grid-row: 2; } }
</style>

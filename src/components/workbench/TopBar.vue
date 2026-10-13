<script setup lang="ts">
import { computed } from 'vue';
import { RadioGroupItem, RadioGroupRoot } from 'reka-ui';
import { LIMITS, type ProcessingPolicy } from '@tinypng/shared';
import type { ConnectionState } from '../../core/cloud/sse';

const props = defineProps<{
  mode: ProcessingPolicy;
  providerLabel?: string;
  running: number;
  hasRunning: boolean;
  networkBlocked: number;
  connection: ConnectionState;
  narrow?: boolean;
}>();
const emit = defineEmits<{ switchMode: [mode: ProcessingPolicy]; openInspector: [] }>();

const isLocal = computed(() => props.mode === 'private-local');
const model = computed({
  get: () => props.mode,
  set: value => { if (value !== props.mode) emit('switchMode', value as ProcessingPolicy); }
});
</script>

<template>
  <header class="topbar" :class="isLocal ? 'is-local' : 'is-cloud'">
    <span class="logo">IMAGE / LAB</span>
    <RadioGroupRoot v-model="model" class="seg" aria-label="处理位置" orientation="horizontal" :disabled="hasRunning">
      <RadioGroupItem value="private-local" class="seg__item seg__item--local" :aria-label="narrow ? '本地私有' : undefined">
        <span aria-hidden="true">🔒</span><span v-if="!narrow">本地私有</span>
      </RadioGroupItem>
      <RadioGroupItem value="cloud" class="seg__item seg__item--cloud" :aria-label="narrow ? '云端处理' : undefined">
        <span aria-hidden="true">☁</span><span v-if="!narrow">云端处理</span>
      </RadioGroupItem>
    </RadioGroupRoot>
    <span v-if="hasRunning && !narrow" class="muted small">处理完成或取消后才能切换</span>

    <div class="status" :class="isLocal ? 'status--local' : 'status--cloud'">
      <template v-if="isLocal">
        <b>{{ narrow ? 'PRIVATE · ' + networkBlocked + ' 网络' : '🔒 PRIVATE · ' + networkBlocked + ' NETWORK REQUESTS' }}</b>
        <span v-if="!narrow">本地处理，效果不保证与云端一致</span>
      </template>
      <template v-else>
        <b>{{ narrow ? 'CLOUD · ' + (providerLabel ?? '') : '☁ CLOUD · ' + (providerLabel ?? '').toUpperCase() }}</b>
        <span v-if="!narrow">图片将上传到自用 Server，再由所选 Provider 处理</span>
      </template>
    </div>

    <span class="spacer" />
    <span v-if="isLocal" class="pill num" :class="{ 'pill--danger': networkBlocked > 0 }" data-testid="network-count">网络请求 {{ networkBlocked }}</span>
    <span class="pill num">运行 {{ running }} / {{ LIMITS.concurrency }}<template v-if="!isLocal && !narrow"> · 全局共享</template></span>
    <span v-if="connection === 'interrupted'" class="pill pill--warning" role="status" aria-live="polite">● 连接中断，正在恢复…</span>
    <button v-if="narrow" type="button" class="btn btn--sm" @click="emit('openInspector')">⚙ 操作设置</button>
  </header>
  <div class="mode-bar" :class="isLocal ? 'mode-bar--local' : 'mode-bar--cloud'" aria-hidden="true" />
</template>

<style scoped>
.topbar { display: flex; align-items: center; gap: var(--s-3); height: var(--topbar-h); padding: 0 var(--s-5); background: var(--surface); border-bottom: 1px solid var(--line); min-width: 0; }
.logo { font-weight: 700; letter-spacing: -.03em; white-space: nowrap; }
.seg { display: inline-flex; padding: 3px; border: 1px solid var(--line-strong); border-radius: var(--r-pill); background: var(--surface-sunken); }
.seg__item { display: inline-flex; gap: 6px; align-items: center; height: 30px; padding: 0 12px; border: 0; border-radius: var(--r-pill); background: transparent; color: var(--ink-muted); cursor: pointer; font-weight: 500; }
.seg__item[data-disabled] { cursor: not-allowed; opacity: .6; }
.seg__item--local[data-state='checked'] { background: var(--local-soft); color: var(--local); }
.seg__item--cloud[data-state='checked'] { background: var(--cloud-soft); color: var(--cloud); }
.status { display: flex; flex-direction: column; min-width: 0; padding: 2px 10px; border-radius: var(--r-sm); font-size: 12px; line-height: 16px; }
.status b { font-weight: 600; white-space: nowrap; }
.status span { color: var(--ink-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.status--local { background: var(--local-soft); color: var(--local); }
.status--cloud { background: var(--cloud-soft); color: var(--cloud); }
.spacer { flex: 1; }
.pill { padding: 3px 10px; border: 1px solid var(--line-strong); border-radius: var(--r-pill); font-size: 12px; white-space: nowrap; }
.is-local .pill[data-testid='network-count'] { color: var(--local); border-color: var(--local); }
.pill--danger { color: var(--danger) !important; border-color: var(--danger) !important; }
.pill--warning { color: var(--warning); border-color: var(--warning); background: var(--warning-soft); }
.muted { color: var(--ink-muted); }
.small { font-size: 12px; }
.mode-bar { height: 3px; }
.mode-bar--local { background: var(--local); }
.mode-bar--cloud { background: var(--cloud); }
.btn { height: 32px; padding: 0 12px; border: 1px solid var(--line-strong); border-radius: var(--r-md); background: var(--surface); color: var(--ink); cursor: pointer; white-space: nowrap; }
@media (max-width: 1023px) { .topbar { padding: 0 var(--s-3); gap: var(--s-2); } }
@media (max-width: 639px) {
  .topbar { height: auto; min-height: var(--topbar-h); padding: 8px; flex-wrap: wrap; gap: 6px; }
  .logo, .spacer { display: none; }
  .status { flex: 1; padding: 2px 6px; }
  .status b { overflow: hidden; text-overflow: ellipsis; }
  .pill { padding: 3px 6px; }
}
</style>

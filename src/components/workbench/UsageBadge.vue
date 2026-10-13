<script setup lang="ts">
import { computed } from 'vue';
import type { UsageView } from '../../stores/usage';

const props = defineProps<{ views: readonly UsageView[]; loading?: boolean; error?: string }>();
const emit = defineEmits<{ refresh: [] }>();
const known = computed(() => props.views.length > 0 && props.views.every(view => view.used !== undefined));
const used = computed(() => props.views.reduce((total, view) => total + (view.used ?? 0), 0));
const remaining = computed(() => known.value && props.views.every(view => view.remaining !== undefined) ? props.views.reduce((total, view) => total + (view.remaining ?? 0), 0) : undefined);
const sourceLabel = (source: UsageView['source']) => ({ 'compression-count': 'Compression-Count', 'provider-query': 'Provider 查询', unknown: '未知' }[source]);
const timeLabel = (time: string) => {
  const date = new Date(time);
  return Number.isNaN(date.getTime()) ? '尚未成功读取' : date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
};
</script>

<template>
  <div class="usage" data-testid="usage">
    <div class="usage__head">
      <strong v-if="!known">用量未知</strong>
      <strong v-else>{{ views.length }} 个账号 · 本月已用 {{ used.toLocaleString() }}</strong>
      <button type="button" class="refresh" :disabled="loading" @click="emit('refresh')">{{ loading ? '读取中…' : '刷新用量' }}</button>
    </div>
    <p v-if="remaining !== undefined">配置预算剩余 {{ remaining.toLocaleString() }} 次</p>
    <p class="help">剩余值依据 Server 配置预算计算，不代表付费账户余额。</p>
    <p v-if="error" class="error" role="status">读取失败：{{ error }}。可重新刷新。</p>
    <details v-if="views.length">
      <summary>查看账号与来源</summary>
      <ul>
        <li v-for="(view, index) in views" :key="index">
          <b class="mono">{{ view.label }}</b>
          <span v-if="view.used === undefined">用量未知</span>
          <span v-else>已用 {{ view.used.toLocaleString() }}<template v-if="view.limit !== undefined"> · 配置预算 {{ view.limit.toLocaleString() }}</template><template v-if="view.remaining !== undefined"> · 预算剩余 {{ view.remaining.toLocaleString() }}</template></span>
          <span>状态：{{ { active: '可用', cooldown: '冷却中', exhausted: '预算已用完', invalid: '认证失效' }[view.status] }}</span>
          <span>来源：{{ sourceLabel(view.source) }} · 更新：{{ timeLabel(view.observedAt) }}</span>
        </li>
      </ul>
    </details>
  </div>
</template>

<style scoped>
.usage { padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--r-md); display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
.usage__head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
p { margin: 0; }
.help { color: var(--ink-muted); line-height: 1.5; }
.error { color: var(--warning); overflow-wrap: anywhere; }
.refresh { border: 0; color: var(--info); background: none; cursor: pointer; white-space: nowrap; padding: 4px; }
.refresh:disabled { opacity: .45; cursor: not-allowed; }
summary { cursor: pointer; color: var(--ink-muted); }
ul { display: grid; gap: 10px; list-style: none; padding: 0; margin: 10px 0 0; }
li { display: flex; flex-direction: column; gap: 4px; overflow-wrap: anywhere; }
.mono { font-family: var(--font-mono); }
</style>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { t } from '../core/i18n';
import type { ShareItem } from '../core/share/types';
import { previewKind } from '../core/share/preview';

const props = defineProps<{ item: ShareItem; top: number; left: number }>();
const emit = defineEmits<{ enter: []; leave: [] }>();
const loading = ref(true);
const failed = ref(false);
const text = ref('');
const imageUrl = ref('');
const mode = ref<'source' | 'preview'>('source');
let request = 0;
const extension = computed(() => props.item.name.split('.').pop()?.toLowerCase() ?? '');
const isImage = computed(() => previewKind(props.item.name) === 'image');
const isHtml = computed(() => previewKind(props.item.name) === 'html');
const sandboxDocument = computed(() => `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:">${text.value}`);
const formatted = computed(() => {
  if (extension.value !== 'json') return text.value;
  try { return JSON.stringify(JSON.parse(text.value), null, 2); } catch { return text.value; }
});
const highlighted = computed(() => {
  const source = formatted.value;
  const pattern = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|#[^\n]*|\/\/[^\n]*|\/\*[\s\S]*?\*\/|\b(?:true|false|null|None|True|False|def|class|import|from|return|if|else|elif|for|while|in|const|let|var|function|async|await|export|new|throw|try|catch)\b|\b\d+(?:\.\d+)?\b)/g;
  const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  let result = '', last = 0;
  for (const match of source.matchAll(pattern)) {
    const value = match[0];
    const kind = /^(?:#|\/\/|\/\*)/.test(value) ? 'comment' : /^["'`]/.test(value) ? 'string' : /^\d/.test(value) ? 'number' : 'keyword';
    result += escape(source.slice(last, match.index)) + `<span class="preview-token-${kind}">${escape(value)}</span>`;
    last = match.index! + value.length;
  }
  return result + escape(source.slice(last));
});
function clearImage() { if (imageUrl.value) URL.revokeObjectURL(imageUrl.value); imageUrl.value = ''; }
watch(() => [props.item.id, props.item.name], async () => {
  const current = ++request;
  clearImage(); loading.value = true; failed.value = false; text.value = ''; mode.value = 'source';
  try {
    const result = await invoke<{ bytes: number[]; mime: string; size: number }>('share_preview_item', { id: props.item.id });
    if (current !== request) return;
    const bytes = new Uint8Array(result.bytes);
    if (isImage.value) imageUrl.value = URL.createObjectURL(new Blob([bytes], { type: result.mime }));
    else text.value = new TextDecoder().decode(bytes);
  } catch { if (current === request) failed.value = true; }
  finally { if (current === request) loading.value = false; }
}, { immediate: true });
onBeforeUnmount(() => { request++; clearImage(); });
</script>

<template>
  <div class="file-preview" tabindex="-1" :style="{ top: `${top}px`, left: `${left}px` }" @mouseenter="emit('enter')" @mouseleave="emit('leave')" @focusin="emit('enter')" @focusout="emit('leave')" @keydown.esc="($event.currentTarget as HTMLElement).blur(); emit('leave')">
    <div class="file-preview-header"><strong :title="item.name">{{ item.name }}</strong>
      <div v-if="isHtml && !loading && !failed" class="file-preview-modes">
        <button type="button" :aria-pressed="mode === 'source'" @click="mode = 'source'">{{ t('源码') }}</button>
        <button type="button" :aria-pressed="mode === 'preview'" @click="mode = 'preview'">{{ t('预览') }}</button>
      </div>
    </div>
    <p v-if="loading">{{ t('正在加载预览…') }}</p>
    <p v-else-if="failed">{{ t('无法加载预览') }}</p>
    <img v-else-if="isImage" :src="imageUrl" :alt="item.name" />
    <iframe v-else-if="isHtml && mode === 'preview'" sandbox="" :srcdoc="sandboxDocument" :title="item.name"></iframe>
    <pre v-else><code v-if="/^(json|py|js|mjs|cjs)$/.test(extension)" v-html="highlighted"></code><code v-else>{{ formatted }}</code></pre>
  </div>
</template>

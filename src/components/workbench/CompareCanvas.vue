<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { SliderRoot, SliderThumb, SliderTrack, ToggleGroupItem, ToggleGroupRoot } from 'reka-ui';
import { compareKey, formatBytes, nextZoom, zoomAt } from '../../core/ui/compare';
import { displayStatus, type WorkbenchItem } from '../../core/workbench/model';
import { sizeChangeLabel } from '../../core/workbench/queue-view';

const props = defineProps<{
  item?: WorkbenchItem;
  sourceUrl?: string;
  resultUrl?: string;
  queuePosition?: number;
  resultError?: string;
  resultLoading?: boolean;
}>();
const emit = defineEmits<{ reloadResult: [] }>();

/** 位置值 = 原图可见比例（0 全显结果，100 全显原图），切换素材时保留 */
const position = ref(50);
const view = ref<'original' | 'split' | 'result'>('split');
const zoom = ref<number | 'fit'>('fit');
const pan = ref({ x: 0, y: 0 });
const checker = ref(true);
const viewport = ref<HTMLElement>();
const box = ref({ w: 0, h: 0 });
const natural = ref({ w: 0, h: 0 });
const resultNatural = ref({ w: 0, h: 0 });
const resultLoaded = ref(false);
const resultError = ref(false);
const sourceError = ref(false);
const announce = ref('');
const dragging = ref<{ x: number; y: number; px: number; py: number }>();

const name = computed(() => (props.item?.source.kind === 'file' ? props.item.source.file.name : props.item?.source.kind === 'url' ? props.item.source.url : ''));
const shown = computed(() => (props.item ? displayStatus(props.item) : undefined));
const hasResult = computed(() => Boolean(props.resultUrl) && !resultError.value && ['completed', 'partial', 'output-failed'].includes(shown.value ?? ''));
const hasSource = computed(() => Boolean(props.sourceUrl) && !sourceError.value);
// URL 原图由 Server 获取，客户端没有字节；结果尺寸仍须独立建立可见画布。
const stageSize = computed(() => {
  if (natural.value.w && natural.value.h) return natural.value;
  if (resultNatural.value.w && resultNatural.value.h) return resultNatural.value;
  return { w: props.item?.output?.width ?? 0, h: props.item?.output?.height ?? 0 };
});

const fitScale = computed(() => {
  if (!stageSize.value.w || !box.value.w) return 1;
  return Math.min(box.value.w / stageSize.value.w, box.value.h / stageSize.value.h, 1);
});
const scale = computed(() => (zoom.value === 'fit' ? fitScale.value : zoom.value));
const offset = computed(() => {
  if (zoom.value === 'fit') {
    return { x: (box.value.w - stageSize.value.w * scale.value) / 2, y: (box.value.h - stageSize.value.h * scale.value) / 2 };
  }
  return pan.value;
});
const stageStyle = computed(() => ({
  width: stageSize.value.w + 'px',
  height: stageSize.value.h + 'px',
  transform: 'translate(' + offset.value.x + 'px,' + offset.value.y + 'px) scale(' + scale.value + ')'
}));
const effectivePos = computed(() => (!hasSource.value ? 0 : view.value === 'original' ? 100 : view.value === 'result' ? 0 : position.value));
const resultClip = computed(() => ({ clipPath: 'inset(0 0 0 ' + effectivePos.value + '%)' }));
const sliderModel = computed({
  get: () => [position.value],
  set: (v: number[]) => { position.value = v[0] ?? 50; }
});
const zoomed = computed(() => zoom.value !== 'fit' && scale.value > fitScale.value + 1e-6);

const originalLabel = computed(() => {
  const it = props.item;
  if (!it) return '';
  const mime = it.source.kind === 'file' ? it.source.file.mime.split('/')[1]?.toUpperCase() : '';
  const dims = natural.value.w ? natural.value.w + '×' + natural.value.h + ' · ' : '';
  return '原图 ' + name.value + ' · ' + dims + (mime ? mime + ' · ' : '') + (it.originalSize ? formatBytes(it.originalSize) : '体积未知');
});
const resultLabel = computed(() => {
  const it = props.item;
  if (!it) return '';
  if (!hasResult.value) return '结果 · 等待处理';
  const o = it.output;
  const w = resultNatural.value.w || o?.width || 0;
  const h = resultNatural.value.h || o?.height || 0;
  const size = it.compressedSize ?? o?.size;
  const fmt = o?.mime ? o.mime.split('/')[1]?.toUpperCase() + ' · ' : '';
  return '结果 ' + (w ? w + '×' + h + ' · ' : '') + fmt + formatBytes(size) + ' · ' + sizeChangeLabel(it.originalSize, size);
});
const placeholder = computed(() => {
  switch (shown.value) {
    case 'draft': return '点击「开始处理」后生成结果';
    case 'queued': return props.queuePosition ? '排队中 · 第 ' + props.queuePosition + ' 位' : '排队中';
    case 'uploading': return '上传中 ' + Math.round((props.item?.progress ?? 0) * 100) + '%';
    case 'processing': return '处理中 ' + Math.round((props.item?.progress ?? 0) * 100) + '%';
    case 'saving': return '保存中 ' + Math.round((props.item?.progress ?? 0) * 100) + '%';
    case 'failed': return props.item?.error?.message ?? '处理失败';
    case 'canceled': return '已取消';
    default: return props.resultError || resultError.value ? '结果预览加载失败' : props.resultLoading ? '正在载入结果…' : '结果暂不可预览';
  }
});

let ro: ResizeObserver | undefined;
onMounted(() => {
  if (!viewport.value) return;
  const measure = () => { box.value = { w: viewport.value!.clientWidth, h: viewport.value!.clientHeight }; };
  measure();
  if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(measure); ro.observe(viewport.value); }
});
onBeforeUnmount(() => ro?.disconnect());

watch(() => props.item?.id, () => { zoom.value = 'fit'; pan.value = { x: 0, y: 0 }; natural.value = { w: 0, h: 0 }; resultNatural.value = { w: 0, h: 0 }; sourceError.value = false; });
watch(() => props.resultUrl, () => { resultLoaded.value = false; resultError.value = false; });
watch(scale, s => { announce.value = '缩放 ' + Math.round(s * 100) + '%'; });

function onSourceLoad(e: Event): void {
  const img = e.target as HTMLImageElement;
  natural.value = { w: img.naturalWidth, h: img.naturalHeight };
}
function onResultLoad(e: Event): void {
  const img = e.target as HTMLImageElement;
  resultNatural.value = { w: img.naturalWidth, h: img.naturalHeight };
  resultLoaded.value = true;
}

function setZoom(next: number | 'fit', px = box.value.w / 2, py = box.value.h / 2): void {
  if (next === 'fit') { zoom.value = 'fit'; return; }
  const from = scale.value;
  pan.value = zoomAt(offset.value, from, next, px, py);
  zoom.value = next;
}

function onThumbKey(e: KeyboardEvent): void {
  const next = compareKey(position.value, e.key, e.shiftKey);
  if (next === undefined) return;
  e.preventDefault();
  e.stopPropagation();
  position.value = next;
}

function onCanvasKey(e: KeyboardEvent): void {
  if (e.target !== viewport.value) return;
  const step = 40;
  if (e.key === '+' || e.key === '=') setZoom(nextZoom(scale.value, 1));
  else if (e.key === '-') setZoom(nextZoom(scale.value, -1));
  else if (e.key === '0') setZoom('fit');
  else if (e.key === '1') setZoom(1);
  else if (zoomed.value && e.key.startsWith('Arrow')) {
    const d = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key] ?? [0, 0];
    pan.value = { x: offset.value.x + d[0]!, y: offset.value.y + d[1]! };
  } else return;
  e.preventDefault();
}

function onWheel(e: WheelEvent): void {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  const rect = viewport.value!.getBoundingClientRect();
  setZoom(nextZoom(scale.value, e.deltaY < 0 ? 1 : -1), e.clientX - rect.left, e.clientY - rect.top);
}

function onPointerDown(e: PointerEvent): void {
  if (!zoomed.value) return;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  dragging.value = { x: offset.value.x, y: offset.value.y, px: e.clientX, py: e.clientY };
}
function onPointerMove(e: PointerEvent): void {
  if (!dragging.value) return;
  pan.value = { x: dragging.value.x + e.clientX - dragging.value.px, y: dragging.value.y + e.clientY - dragging.value.py };
}
function onPointerUp(): void { dragging.value = undefined; }
</script>

<template>
  <div class="canvas">
    <div
      ref="viewport"
      class="viewport"
      :class="{ checker, 'is-zoomed': zoomed, 'is-dragging': dragging }"
      role="group"
      :aria-label="'图片预览 ' + name"
      tabindex="0"
      @keydown="onCanvasKey"
      @wheel="onWheel"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
    >
      <slot v-if="!item" name="empty" />
      <template v-else>
        <div v-if="!natural.w && sourceUrl && !sourceError" class="skeleton" />
        <p v-if="sourceError" class="source-error" role="status">原图预览加载失败，请重新选择有效的图片。</p>
        <p v-else-if="!sourceUrl && item.source.kind === 'url'" class="source-notice" role="status">原图不可预览，当前仅显示处理结果。</p>
        <div class="layer">
          <div class="stage" :style="stageStyle">
            <img v-if="sourceUrl" :src="sourceUrl" alt="" draggable="false" @load="onSourceLoad" @error="sourceError = true">
          </div>
        </div>
        <div v-if="hasResult" class="layer layer--result" :style="resultClip">
          <div class="stage" :style="stageStyle">
            <img :src="resultUrl" alt="" draggable="false" :class="{ loaded: resultLoaded }" @load="onResultLoad" @error="resultError = true">
          </div>
        </div>
        <div v-else class="layer layer--result layer--pending checker" :style="resultClip">
          <div class="placeholder"><p>{{ placeholder }}</p><button v-if="resultError || props.resultError" type="button" class="btn btn--sm" @click="emit('reloadResult')">重新加载预览</button></div>
        </div>

        <span class="label label--left" :class="{ faded: effectivePos < 10 }">{{ originalLabel }}</span>
        <span class="label label--right" :class="{ faded: effectivePos > 90 }">{{ resultLabel }}</span>

        <SliderRoot
          v-if="view === 'split' && hasSource"
          v-model="sliderModel"
          class="split"
          :class="{ 'split--passive': zoomed }"
          :min="0" :max="100" :step="1"
          :disabled="!hasResult"
        >
          <SliderTrack class="split__track" />
          <SliderThumb
            class="split__thumb"
            aria-label="原图与结果对比"
            :aria-valuetext="'原图显示 ' + position + '%'"
            :tabindex="hasResult ? 0 : -1"
            @keydown.capture="onThumbKey"
            @dblclick="position = 50"
          >
            <span class="split__line" aria-hidden="true" />
            <span class="split__knob" aria-hidden="true">⇔</span>
          </SliderThumb>
        </SliderRoot>
      </template>
      <p class="sr-only" aria-live="polite">{{ announce }}</p>
    </div>

    <div v-if="item" class="tools">
      <button type="button" class="btn btn--sm" :aria-pressed="zoom === 'fit'" @click="setZoom('fit')">适应</button>
      <button type="button" class="btn btn--sm" :aria-pressed="zoom === 1" @click="setZoom(1)">100%</button>
      <button type="button" class="btn btn--sm" aria-label="缩小" @click="setZoom(nextZoom(scale, -1))">−</button>
      <span class="zoom num">{{ Math.round(scale * 100) }}%</span>
      <button type="button" class="btn btn--sm" aria-label="放大" @click="setZoom(nextZoom(scale, 1))">＋</button>
      <ToggleGroupRoot v-model="view" type="single" class="toggle" aria-label="对比模式">
        <ToggleGroupItem value="original" class="btn btn--sm" :disabled="!hasSource">仅原图</ToggleGroupItem>
        <ToggleGroupItem value="split" class="btn btn--sm" :disabled="!hasSource">分割</ToggleGroupItem>
        <ToggleGroupItem value="result" class="btn btn--sm" :disabled="!hasResult">仅结果</ToggleGroupItem>
      </ToggleGroupRoot>
      <button type="button" class="btn btn--sm" :aria-pressed="checker" @click="checker = !checker">▦ 棋盘格</button>
    </div>
  </div>
</template>

<style scoped>
.canvas { position: relative; display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--surface-sunken); border: 1px solid var(--line); border-radius: var(--r-lg); overflow: hidden; }
.viewport { position: relative; flex: 1; min-height: 200px; overflow: hidden; touch-action: none; outline-offset: -2px; }
.viewport:not(.checker) { background: var(--surface-sunken); }
.viewport.is-zoomed { cursor: grab; }
.viewport.is-dragging { cursor: grabbing; }
.layer { position: absolute; inset: 0; }
.stage { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
.stage img { display: block; width: 100%; height: 100%; object-fit: contain; user-select: none; }
.layer--result img { opacity: 0; transition: opacity var(--dur-fast) ease-out; }
.layer--result img.loaded { opacity: 1; }
.layer--pending { display: grid; place-items: center; }
.placeholder { margin: 0 0 0 40%; padding: 6px 10px; border-radius: var(--r-sm); background: var(--surface); color: var(--ink-muted); font-size: 13px; }
.placeholder p { margin: 0 0 4px; }
.skeleton { position: absolute; inset: 24px; border-radius: var(--r-md); background: var(--surface-sunken); }
.source-error { position: absolute; left: 12px; bottom: 12px; z-index: 3; max-width: calc(100% - 24px); padding: 8px; background: var(--surface); color: var(--danger); font-size: 12px; border-radius: var(--r-sm); }
.source-notice { position: absolute; left: 12px; bottom: 12px; z-index: 3; max-width: calc(100% - 24px); padding: 6px 8px; background: var(--surface); color: var(--ink-muted); font-size: 12px; border-radius: var(--r-sm); }
.label { position: absolute; top: 12px; max-width: 46%; padding: 4px 8px; border-radius: var(--r-sm); background: var(--surface); border: 1px solid var(--line); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; transition: opacity var(--dur-fast); z-index: 2; }
.label--left { left: 12px; }
.label--right { right: 12px; }
.faded { opacity: 0; }
.split { position: absolute; inset: 0; display: flex; align-items: center; z-index: 1; cursor: ew-resize; user-select: none; touch-action: none; }
.split--passive { pointer-events: none; }
.split--passive .split__thumb { pointer-events: auto; }
.split[data-disabled] { cursor: default; }
.split__track { position: relative; flex: 1; height: 100%; }
.split__thumb { position: relative; display: block; width: 44px; height: 100%; cursor: ew-resize; background: transparent; }
.split__thumb[data-disabled] { display: none; }
.split__line { position: absolute; left: 21px; top: 0; bottom: 0; width: 2px; background: var(--surface); box-shadow: 0 0 0 1px rgb(30 41 59 / .25); }
.split__knob { position: absolute; left: 8px; top: 50%; width: 28px; height: 28px; margin-top: -14px; display: grid; place-items: center; border-radius: 50%; background: var(--surface); border: 1px solid var(--line-strong); font-size: 12px; box-shadow: var(--shadow-pop); }
.split__thumb:focus-visible .split__knob { outline: 2px solid var(--focus); outline-offset: 2px; }
.tools { display: flex; flex-wrap: wrap; justify-content: center; align-items: center; gap: 6px; padding: 8px; border-top: 1px solid var(--line); background: var(--surface); }
.toggle { display: inline-flex; gap: 2px; }
.toggle [data-state='on'] { background: var(--ink); color: var(--accent-ink); }
.zoom { min-width: 44px; text-align: center; font-size: 12px; }
.btn { height: 28px; padding: 0 10px; border: 1px solid var(--line-strong); border-radius: var(--r-md); background: var(--surface); color: var(--ink); cursor: pointer; font-size: 13px; }
.btn[aria-pressed='true'] { background: var(--surface-sunken); }
.btn:disabled, .btn[data-disabled] { opacity: .45; cursor: not-allowed; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
@media (prefers-reduced-motion: reduce) { .layer--result img { transition: none; } }
</style>

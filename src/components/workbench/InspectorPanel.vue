<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { RadioGroupItem, RadioGroupRoot } from 'reka-ui';
import { LIMITS, type ImageFormat, type ImageProviderManifest, type Operation, type ProcessingPolicy, type ProviderId } from '@tinypng/shared';
import type { Pipeline } from '../../core/workbench/model';
import { containHint, localPngHint, qualityHint } from '../../core/workbench/hints';
import { LOCAL_MANIFEST, type OperationConflict } from '../../core/workbench/providers';
import type { UsageView } from '../../stores/usage';
import UsageBadge from './UsageBadge.vue';

const props = defineProps<{
  mode: ProcessingPolicy;
  pipeline: Pipeline;
  inputMimes: readonly string[];
  cloudManifests: readonly ImageProviderManifest[];
  conflicts: readonly OperationConflict[];
  draftCount: number;
  runningCount: number;
  total: number;
  canStart: boolean;
  hasRunning: boolean;
  serverUrl: string;
  hasToken: boolean;
  manifestLoading?: boolean;
  manifestError?: string;
  usageViews: readonly UsageView[];
  usageLoading?: boolean;
  usageError?: string;
  pipelineError?: string;
  pipelineLocked?: boolean;
  /** 窄窗口下开始按钮移到吸底操作栏 */
  hideStart?: boolean;
}>();
const emit = defineEmits<{
  update: [pipeline: Pipeline];
  start: [];
  saveServer: [url: string, token: string];
  refreshUsage: [];
  refreshProviders: [];
  switchCloud: [];
}>();

type ResizeOp = Extract<Operation, { type: 'resize' }>;
const isLocal = computed(() => props.mode === 'private-local');
const manifest = computed(() => isLocal.value ? LOCAL_MANIFEST : props.cloudManifests.find(m => m.id === props.pipeline.providerId));
const capability = (type: 'compress' | 'convert' | 'resize') => {
  const value = manifest.value?.capabilities[type];
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
};
const formatAllowed = (format: ImageFormat) => manifest.value?.capabilities.convert.includes(format) ?? false;
const capabilityLabel = (provider: ImageProviderManifest) => {
  const c = provider.capabilities;
  const names = [c.compress && '压缩', c.convert.length > 0 && '转换', c.resize && '缩放'].filter(Boolean);
  return names.length === 1 && names[0] === '压缩' ? '仅压缩' : names.join(' · ') || '暂无可用操作';
};
const compress = computed(() => props.pipeline.operations.find(op => op.type === 'compress') as Extract<Operation, { type: 'compress' }> | undefined);
const convert = computed(() => props.pipeline.operations.find(op => op.type === 'convert') as Extract<Operation, { type: 'convert' }> | undefined);
const resize = computed(() => props.pipeline.operations.find(op => op.type === 'resize') as ResizeOp | undefined);

const quality = computed(() => qualityHint(props.pipeline, props.inputMimes));
const pngHint = computed(() => localPngHint(props.mode, props.pipeline, props.inputMimes));
const padHint = computed(() => (resize.value ? containHint(resize.value, props.pipeline, props.inputMimes) : undefined));
const conflictTypes = computed(() => new Set(props.conflicts.map(c => c.operation.type)));

const formats: Array<{ value: ImageFormat; label: string }> = [
  { value: 'png', label: 'PNG' }, { value: 'jpeg', label: 'JPG' }, { value: 'webp', label: 'WebP' }, { value: 'avif', label: 'AVIF' }
];

/** 固定顺序：压缩 → 转换 → 缩放 */
function rebuild(patch: { compress?: Operation | null; convert?: Operation | null; resize?: Operation | null }): void {
  const pick = <K extends keyof typeof patch>(k: K, cur: Operation | undefined) => (k in patch ? patch[k] ?? undefined : cur);
  const ops = [pick('compress', compress.value), pick('convert', convert.value), pick('resize', resize.value)].filter((o): o is Operation => Boolean(o));
  emit('update', { ...props.pipeline, operations: ops });
}
function setProvider(id: ProviderId): void {
  emit('update', { ...props.pipeline, providerId: id });
}
function toggle(kind: 'compress' | 'convert' | 'resize', on: boolean): void {
  if (on && !capability(kind)) return;
  const format = manifest.value?.capabilities.convert.includes('webp') ? 'webp' : manifest.value?.capabilities.convert[0] ?? 'webp';
  const defaults: Record<string, Operation> = { compress: { type: 'compress' }, convert: { type: 'convert', format }, resize: { type: 'resize', width: 1600, fit: 'inside' } };
  rebuild({ [kind]: on ? defaults[kind] : null });
}
function setQuality(v: string): void { if (!quality.value.disabled && !props.pipelineLocked) rebuild({ compress: { type: 'compress', quality: Number(v) / 100 } }); }
function qualityInput(event: Event): void {
  const input = event.target as HTMLInputElement;
  if (quality.value.disabled || props.pipelineLocked) input.value = String(Math.round((compress.value?.quality ?? 0.82) * 100));
  else setQuality(input.value);
}
function qualityKey(event: KeyboardEvent): void {
  if ((quality.value.disabled || props.pipelineLocked) && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) event.preventDefault();
}
function autoQuality(): void { rebuild({ compress: { type: 'compress' } }); }
function setFormat(f: string): void { if (formatAllowed(f as ImageFormat)) rebuild({ convert: { type: 'convert', format: f as ImageFormat } }); }
function setResize(patch: Partial<ResizeOp>): void {
  const cur: ResizeOp = resize.value ?? { type: 'resize', fit: 'inside' };
  const next = { ...cur, ...patch };
  if (!next.width) delete next.width;
  if (!next.height) delete next.height;
  rebuild({ resize: next });
}
const num = (e: Event) => { const v = Number((e.target as HTMLInputElement).value); return Number.isFinite(v) && v > 0 ? Math.round(v) : undefined; };

const startNote = computed(() => {
  if (props.conflicts.length) return '当前线路不支持部分操作';
  if (props.pipelineError) return props.pipelineError;
  if (!isLocal.value && !manifest.value) return '先保存 Server 并获取可用线路';
  if (props.draftCount > 0) return '加入的图片不会自动处理 · 同时处理 ' + LIMITS.concurrency + ' 张';
  if (props.hasRunning) return '处理中 ' + props.runningCount + ' / ' + props.total;
  return '先添加图片';
});

const urlDraft = ref(props.serverUrl);
const tokenDraft = ref('');
const serverExpanded = ref(false);
const operationNames: Record<string, string> = { compress: '压缩', convert: '转换格式', resize: '缩放' };
function keepCompress(): void { emit('update', { ...props.pipeline, operations: [{ type: 'compress' }] }); }
function saveServer(): void {
  emit('saveServer', urlDraft.value, tokenDraft.value);
  tokenDraft.value = '';
}
watch(() => props.serverUrl, v => { urlDraft.value = v; });
</script>

<template>
  <aside class="inspector" aria-label="操作设置">
    <section v-if="!isLocal" class="group">
      <h3>处理线路</h3>
      <button v-if="serverUrl && hasToken" type="button" class="link" :disabled="hasRunning || pipelineLocked" :aria-expanded="serverExpanded" @click="serverExpanded = !serverExpanded">连接设置</button>
      <div v-if="!serverUrl || !hasToken || serverExpanded" class="server">
        <label>Server 地址<input v-model="urlDraft" type="url" placeholder="http://127.0.0.1:8787"></label>
        <label>访问令牌<input v-model="tokenDraft" type="password" autocomplete="off" :placeholder="hasToken ? '已保存' : ''"></label>
        <p class="help">令牌只存在系统钥匙串（桌面端）或本标签页（Web），不会写入 localStorage。</p>
        <button type="button" class="btn btn--sm" :disabled="hasRunning || pipelineLocked || !urlDraft.trim()" @click="saveServer">保存并连接</button>
      </div>
      <RadioGroupRoot v-if="cloudManifests.length" :model-value="pipeline.providerId" class="providers" aria-label="Provider" @update:model-value="v => setProvider(String(v))">
        <RadioGroupItem v-for="m in cloudManifests" :key="m.id" :value="m.id" class="prov" :disabled="pipelineLocked">
          <b>◉ {{ m.label }}</b>
          <span class="tag">{{ capabilityLabel(m) }}</span>
        </RadioGroupItem>
      </RadioGroupRoot>
      <p v-if="pipeline.providerId === 'anonymous-tinify'" class="help">仅压缩 · 免 API key · 非官方接口，可能失效。访问 Server 仍需令牌。</p>
      <p v-if="manifestLoading" class="help" role="status">正在获取线路…</p>
      <p v-else-if="manifestError" class="alert" role="alert">线路获取失败：{{ manifestError }}。<button type="button" class="link" @click="emit('refreshProviders')">重新连接</button></p>
      <p v-else-if="serverUrl && !cloudManifests.length" class="help">暂无可用线路，请检查 Server 配置。</p>
      <div v-if="conflicts.length" class="alert" role="alert">
        <p>当前线路不支持：{{ conflicts.map(c => operationNames[c.operation.type] ?? c.operation.type).join('、') }}。</p>
        <p v-if="pipeline.providerId === 'anonymous-tinify'">匿名线路只支持压缩，请改用官方线路。</p>
        <div class="row">
          <button v-if="cloudManifests.some(m => m.id === 'official-tinify')" type="button" class="btn btn--sm" :disabled="pipelineLocked" @click="setProvider('official-tinify')">切换到官方 Tinify</button>
          <button type="button" class="btn btn--sm" :disabled="pipelineLocked" @click="keepCompress">只保留压缩</button>
        </div>
      </div>
      <UsageBadge v-if="pipeline.providerId === 'official-tinify'" :views="usageViews" :loading="usageLoading" :error="usageError" @refresh="emit('refreshUsage')" />
    </section>

    <section class="group">
      <h3>操作链</h3>
      <p v-if="pipelineLocked" class="help">本批次方案已固定。清空任务后可修改线路和操作链。</p>
      <p v-if="pipelineError" class="alert" role="alert">{{ pipelineError }}</p>
      <div class="node" :class="{ 'node--bad': conflictTypes.has('compress') }">
        <label class="node__head"><input type="checkbox" :checked="Boolean(compress)" :disabled="pipelineLocked || (!capability('compress') && !compress)" @change="toggle('compress', ($event.target as HTMLInputElement).checked)"><span class="no">1</span>压缩</label>
        <div v-if="compress" class="node__body">
          <label class="row">
            质量
            <input type="range" min="10" max="100" step="1" :value="Math.round((compress.quality ?? 0.82) * 100)" :aria-disabled="quality.disabled || pipelineLocked" aria-label="压缩质量" aria-describedby="quality-note" @keydown="qualityKey" @input="qualityInput">
            <span class="num">{{ compress.quality === undefined ? '自动' : Math.round(compress.quality * 100) }}</span>
            <button v-if="compress.quality !== undefined" type="button" class="link" :disabled="pipelineLocked" @click="autoQuality">自动</button>
          </label>
          <p v-if="quality.note" id="quality-note" class="help">{{ quality.note }}</p>
          <div v-if="pngHint" class="hint" role="status"><p data-testid="png-local-hint">{{ pngHint }}</p><button type="button" class="link" :disabled="hasRunning" @click="emit('switchCloud')">切到云端</button></div>
        </div>
      </div>

      <div class="node" :class="{ 'node--bad': conflictTypes.has('convert') }">
        <label class="node__head"><input type="checkbox" :checked="Boolean(convert)" :disabled="pipelineLocked || (!capability('convert') && !convert)" @change="toggle('convert', ($event.target as HTMLInputElement).checked)"><span class="no">2</span>转换格式</label>
        <p v-if="!capability('convert')" class="help">{{ manifest ? manifest.label + '不支持转换格式' : '获取线路能力后可设置' }}</p>
        <div v-if="convert" class="node__body">
          <RadioGroupRoot :model-value="convert.format" class="chips" aria-label="输出格式" orientation="horizontal" @update:model-value="v => setFormat(String(v))">
            <RadioGroupItem v-for="f in formats" :key="f.value" :value="f.value" class="chip" :disabled="pipelineLocked || !formatAllowed(f.value)" :title="!formatAllowed(f.value) ? '当前线路不支持 ' + f.label : undefined">{{ f.label }}</RadioGroupItem>
          </RadioGroupRoot>
          <p v-if="isLocal" class="help">AVIF：本地版暂不支持</p>
        </div>
      </div>

      <div class="node" :class="{ 'node--bad': conflictTypes.has('resize') }">
        <label class="node__head"><input type="checkbox" :checked="Boolean(resize)" :disabled="pipelineLocked || (!capability('resize') && !resize)" @change="toggle('resize', ($event.target as HTMLInputElement).checked)"><span class="no">3</span>缩放</label>
        <p v-if="!capability('resize')" class="help">{{ manifest ? manifest.label + '不支持缩放' : '获取线路能力后可设置' }}</p>
        <div v-if="resize" class="node__body">
          <div class="row">
            <label>宽<input type="number" min="1" inputmode="numeric" :value="resize.width" :disabled="pipelineLocked" :aria-invalid="resize.fit !== 'inside' && !resize.width" aria-describedby="resize-help" @input="setResize({ width: num($event) })"><span class="unit">px</span></label>
            <label>高<input type="number" min="1" inputmode="numeric" :value="resize.height" :disabled="pipelineLocked" :aria-invalid="resize.fit !== 'inside' && !resize.height" aria-describedby="resize-help" @input="setResize({ height: num($event) })"><span class="unit">px</span></label>
          </div>
          <RadioGroupRoot :model-value="resize.fit" :disabled="pipelineLocked" class="chips" aria-label="缩放方式" orientation="horizontal" @update:model-value="v => setResize({ fit: v as ResizeOp['fit'] })">
            <RadioGroupItem value="inside" class="chip" title="等比缩到框内，不放大">inside</RadioGroupItem>
            <RadioGroupItem value="contain" class="chip" title="等比放进框内，补边到框尺寸">contain</RadioGroupItem>
            <RadioGroupItem value="cover" class="chip" title="等比铺满框，居中裁切">cover</RadioGroupItem>
          </RadioGroupRoot>
          <p id="resize-help" class="help"><span v-if="padHint" data-testid="contain-hint">{{ padHint }}</span><span v-else-if="resize.fit === 'inside'">等比缩进框内，小图不放大。</span><span v-else-if="resize.fit === 'cover'">居中裁切到指定宽高。</span><span v-else>填写宽和高，PNG/WebP 补透明边，JPG 补白边。</span></p>
          <p v-if="resize.fit === 'contain'" class="help">小图不放大，保持原尺寸并居中补边。</p>
        </div>
      </div>

      <div class="node node--off" aria-disabled="true"><span class="no">·</span>裁切 · 兴趣区裁切 · 元数据<span class="tag">后续支持</span></div>
    </section>

    <section class="group">
      <h3>输出到</h3>
      <div class="node"><label class="node__head"><input type="checkbox" checked disabled>下载到本地</label><span class="tag">单张 / zip</span></div>
      <div class="node node--off" aria-disabled="true">覆盖原图 · S3 / GCS<span class="tag">后续支持</span></div>
    </section>

    <div v-if="!hideStart" class="start">
      <button type="button" class="btn btn--primary" :disabled="!canStart || conflicts.length > 0" :aria-describedby="'start-note'" @click="emit('start')">▶ 开始处理 ({{ draftCount }})</button>
      <p id="start-note" class="help center" :class="{ warn: conflicts.length }">{{ startNote }}</p>
    </div>
  </aside>
</template>

<style scoped>
.inspector { display: flex; flex-direction: column; gap: var(--s-4); height: 100%; min-height: 0; overflow: auto; padding: var(--s-4); background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg); }
h3 { margin: 0 0 var(--s-2); font-size: 14px; line-height: 18px; font-weight: 600; }
.group { display: flex; flex-direction: column; gap: var(--s-2); }
.node { padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--r-md); background: var(--surface); display: flex; flex-direction: column; gap: 8px; }
.node--bad { border-color: var(--warning); background: var(--warning-soft); }
.node--off { flex-direction: row; align-items: center; gap: 8px; color: var(--ink-faint); background: var(--surface-sunken); }
.node__head { display: flex; align-items: center; gap: 8px; font-weight: 500; cursor: pointer; }
.node__body { display: flex; flex-direction: column; gap: 8px; padding-left: 24px; }
.no { display: inline-grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; background: var(--surface-sunken); font-size: 12px; }
.tag { margin-left: auto; padding: 1px 8px; border-radius: var(--r-pill); background: var(--surface-sunken); color: var(--ink-muted); font-size: 12px; }
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.row label { display: flex; align-items: center; gap: 4px; }
input[type='number'], input[type='url'], input[type='password'] { height: 32px; width: 96px; padding: 0 8px; border: 1px solid var(--line-strong); border-radius: var(--r-sm); background: var(--surface-sunken); color: var(--ink); }
input[type='url'], input[type='password'] { width: 100%; }
input[type='range'] { flex: 1; min-width: 100px; accent-color: var(--ink); }
input[type='range'][aria-disabled='true'] { opacity: .45; pointer-events: none; }
.unit { color: var(--ink-muted); font-size: 12px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { height: 28px; padding: 0 10px; border: 1px solid var(--line-strong); border-radius: var(--r-pill); background: var(--surface); color: var(--ink); cursor: pointer; font-size: 13px; }
.chip[data-state='checked'] { background: var(--ink); color: var(--accent-ink); border-color: var(--ink); }
.chip[data-disabled] { opacity: .45; cursor: not-allowed; }
.providers { display: flex; flex-direction: column; gap: 6px; }
.prov { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--r-md); background: var(--surface); text-align: left; cursor: pointer; color: var(--ink); }
.prov[data-state='checked'] { border-color: var(--cloud); background: var(--cloud-soft); }
.server { display: flex; flex-direction: column; gap: 8px; }
.server label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; font-weight: 500; }
.help { margin: 0; color: var(--ink-muted); font-size: 12px; line-height: 16px; }
.hint { margin: 0; padding: 6px 10px; border-radius: var(--r-sm); background: var(--warning-soft); color: var(--warning); font-size: 12px; }
.hint p, .alert p { margin: 0 0 6px; }
.alert { margin: 0; padding: 8px 10px; border-radius: var(--r-sm); background: var(--warning-soft); color: var(--warning); font-size: 13px; }
.center { text-align: center; }
.warn { color: var(--warning); }
.start { position: sticky; bottom: 0; margin-top: auto; padding-top: var(--s-2); background: var(--surface); display: flex; flex-direction: column; gap: 6px; }
.btn { height: 32px; padding: 0 12px; border: 1px solid var(--line-strong); border-radius: var(--r-md); background: var(--surface); color: var(--ink); cursor: pointer; }
.btn--sm { height: 28px; align-self: flex-start; }
.btn--primary { height: 44px; width: 100%; background: var(--accent); color: var(--accent-ink); border-color: var(--accent); font-weight: 600; font-size: 15px; }
.btn:disabled { opacity: .45; cursor: not-allowed; }
.link { border: 0; background: none; color: var(--info); cursor: pointer; padding: 0; font-size: 12px; }
</style>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue';
import { AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogOverlay, AlertDialogPortal, AlertDialogRoot, AlertDialogTitle, DialogClose, DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui';
import type { ProcessingPolicy } from '@tinypng/shared';
import TopBar from './components/workbench/TopBar.vue';
import AssetRail from './components/workbench/AssetRail.vue';
import CompareCanvas from './components/workbench/CompareCanvas.vue';
import InspectorPanel from './components/workbench/InspectorPanel.vue';
import QueuePanel from './components/workbench/QueuePanel.vue';
import type { FileAdapter, SourceFile } from './core/files/contracts';
import type { QueueAction } from './core/workbench/queue-view';
import type { Pipeline } from './core/workbench/model';
import { ApiClient } from './core/cloud/api-client';
import { useMediaQuery } from './core/ui/use-media';
import { resultFilename, saveBlob } from './core/files/downloads';
import { WebFileAdapter } from './platform/web';
import { getAdapter } from './platform/runtime';
import { useWorkbenchStore } from './stores/workbench';
import { useProviderStore } from './stores/provider';
import { useSettingsStore } from './stores/settings';
import { useUsageStore } from './stores/usage';

const workbench = useWorkbenchStore();
const providers = useProviderStore();
const settings = useSettingsStore();
const usage = useUsageStore();
//#region 工作台界面状态
const narrow = useMediaQuery('(max-width: 1023px)');
const adapter = shallowRef<FileAdapter>();
const notice = ref('');
const inspectorOpen = ref(false);
const queueOpen = ref(true);
const thumbs = reactive<Record<string, string>>({});
const resultUrl = ref<string>();
const previewError = ref('');
const previewLoading = ref(false);
const cancelDialogOpen = ref(false);
const archiveBusy = ref(false);
const archiveError = ref('');
let archiveController: AbortController | undefined;
let drawerTrigger: HTMLElement | undefined;
let usageTimer: ReturnType<typeof setTimeout> | undefined;
let previewSeq = 0;

const cloudManifests = computed(() => providers.cloudManifests);
const providerLabel = computed(() => providers.manifest(workbench.pipeline.providerId)?.label ?? (workbench.mode === 'cloud' ? '官方 Tinify' : '本地 Canvas'));
const conflicts = computed(() => providers.conflicts(workbench.pipeline));
const canStart = computed(() => workbench.canStart && conflicts.value.length === 0 && (workbench.mode === 'private-local' || (!providers.loading && !providers.error && Boolean(providers.manifest(workbench.pipeline.providerId)))));
const usageViews = computed(() => usage.views(workbench.pipeline.providerId));
const selectedRow = computed(() => workbench.queue.find(r => r.item.id === workbench.selectedItemId));
const queuePosition = computed(() => {
  const text = selectedRow.value?.view.state === 'queued' ? selectedRow.value.view.text : '';
  const m = text.match(/第 (\d+) 位/);
  return m ? Number(m[1]) : undefined;
});
//#endregion

function toast(text: string): void {
  notice.value = text;
  window.setTimeout(() => { if (notice.value === text) notice.value = ''; }, 5000);
}
function errorText(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}

//#region 初始化与云端能力读取
onMounted(async () => {
  try {
    adapter.value = await getAdapter();
    await settings.loadToken();
    workbench.setPipeline(settings.mode === 'cloud' ? { ...settings.defaultPipeline, providerId: settings.defaultPipeline.providerId === 'local' ? 'official-tinify' : settings.defaultPipeline.providerId } : { ...settings.defaultPipeline, providerId: 'local' });
    if (settings.mode === 'cloud') {
      workbench.mode = 'cloud';
      await refreshProviders();
    }
  } catch (e) {
    toast(errorText(e, '平台能力加载失败'));
  }
});

async function refreshProviders(): Promise<void> {
  if (workbench.mode !== 'cloud' || !settings.serverUrl) return;
  const baseUrl = settings.serverUrl;
  const api = new ApiClient({ baseUrl, getToken: () => settings.getToken(baseUrl) });
  await providers.refresh(() => api.providers());
  if (!providers.error) await refreshUsage();
}

async function refreshUsage(): Promise<void> {
  if (workbench.mode !== 'cloud' || workbench.pipeline.providerId !== 'official-tinify' || !settings.serverUrl) return;
  const baseUrl = settings.serverUrl;
  const api = new ApiClient({ baseUrl, getToken: () => settings.getToken(baseUrl) });
  await usage.refresh(workbench.pipeline.providerId, id => api.usage(id));
}

watch(() => [workbench.mode, workbench.pipeline.providerId, workbench.items.filter(item => ['completed', 'failed', 'canceled'].includes(item.status)).length] as const, () => {
  if (usageTimer) clearTimeout(usageTimer);
  if (workbench.mode === 'cloud') usageTimer = setTimeout(() => { void refreshUsage(); }, 250);
});
//#endregion

//#region 本地字节预览与生命周期
// 缩略图 / 原图预览：本地字节 → blob URL（不产生网络请求）
watch(() => workbench.items.map(i => i.id), async ids => {
  for (const id of ids) {
    if (thumbs[id]) continue;
    thumbs[id] = 'pending';
    const blob = await workbench.sourceBlob(id).catch(() => undefined);
    if (blob && workbench.items.some(item => item.id === id)) thumbs[id] = URL.createObjectURL(blob);
    else delete thumbs[id];
  }
  for (const id of Object.keys(thumbs)) {
    if (!ids.includes(id)) { URL.revokeObjectURL(thumbs[id]!); delete thumbs[id]; }
  }
}, { immediate: true });
const visibleThumbs = computed(() => Object.fromEntries(Object.entries(thumbs).filter(([, v]) => v !== 'pending')));

async function loadPreview(): Promise<void> {
  const request = ++previewSeq;
  if (resultUrl.value) URL.revokeObjectURL(resultUrl.value);
  resultUrl.value = undefined;
  previewError.value = '';
  const id = workbench.selectedItemId;
  const state = selectedRow.value?.view.state;
  if (!id || !state || !['completed', 'partial', 'output-failed'].includes(state)) return;
  previewLoading.value = true;
  try {
    const blob = await workbench.resultBlob(id);
    if (request === previewSeq && blob && workbench.selectedItemId === id) resultUrl.value = URL.createObjectURL(blob);
  } catch (error) {
    if (request === previewSeq) previewError.value = errorText(error, '结果预览加载失败');
  } finally {
    if (request === previewSeq) previewLoading.value = false;
  }
}
watch(() => [workbench.selectedItemId, selectedRow.value?.view.state] as const, loadPreview);
onBeforeUnmount(() => {
  previewSeq++;
  archiveController?.abort();
  if (usageTimer) clearTimeout(usageTimer);
  Object.values(thumbs).forEach(url => { if (url !== 'pending') URL.revokeObjectURL(url); });
  if (resultUrl.value) URL.revokeObjectURL(resultUrl.value);
});

function openInspector(): void {
  drawerTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  inspectorOpen.value = true;
}
function closeDrawerFocus(event: Event): void { event.preventDefault(); drawerTrigger?.focus(); }
//#endregion

//#region 素材导入与处理方案
function add(files: readonly SourceFile[]): void {
  if (!files.length) { toast('没有找到支持的 PNG、JPG 或 WebP 图片'); return; }
  try {
    workbench.addFiles(files);
  } catch (e) {
    toast(errorText(e, '添加失败'));
  }
}
async function chooseFiles(): Promise<void> {
  if (!adapter.value) return;
  try { add(await adapter.value.chooseFiles()); } catch (e) { toast(errorText(e, '选择文件失败')); }
}
async function chooseDirectory(): Promise<void> {
  if (!adapter.value) return;
  try { add(await adapter.value.chooseDirectory()); } catch (e) { toast(errorText(e, '选择文件夹失败')); }
}
function dropFiles(files: File[]): void {
  if (!(adapter.value instanceof WebFileAdapter)) { toast('桌面端请使用系统文件选择器导入图片'); return; }
  add(adapter.value.fromFiles(files));
}
function addUrls(urls: string[]): void {
  try { workbench.addUrls(urls); } catch (e) { toast(errorText(e, '添加 URL 失败')); }
}

async function switchMode(mode: ProcessingPolicy): Promise<void> {
  try {
    const providerId = mode === 'cloud' ? (providers.selectedCloudId || 'official-tinify') : 'local';
    const { removedUrlDrafts } = await workbench.switchMode(mode, providerId);
    settings.setMode(mode);
    if (removedUrlDrafts) toast('已移除 ' + removedUrlDrafts + ' 个 URL 草稿（本地模式不支持 URL）');
    if (mode === 'cloud') await refreshProviders();
  } catch (e) {
    toast(errorText(e, '切换失败'));
  }
}

function updatePipeline(pipeline: Pipeline): void {
  try {
    workbench.setPipeline(pipeline);
    if (pipeline.providerId !== 'local') providers.selectCloud(pipeline.providerId);
    settings.setDefaultPipeline(pipeline);
  } catch (e) {
    toast(errorText(e, '修改操作链失败'));
  }
}

async function start(): Promise<void> {
  if (!canStart.value) return;
  inspectorOpen.value = false;
  try { await workbench.start(); } catch (e) { toast(errorText(e, '开始处理失败')); }
}

async function cancelAll(): Promise<void> {
  try { await workbench.cancelAll(); }
  catch (error) { toast(errorText(error, '取消失败，请重试')); }
}

async function saveServer(url: string, token: string): Promise<void> {
  try {
    if (workbench.hasRunning || workbench.pipelineLocked) throw new Error('清空任务后才能修改连接设置');
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Server 地址只支持 http 或 https');
    // 已有未上传草稿应使用新连接，清理旧执行器后原样重建。
    const drafts = workbench.items.filter(item => item.status === 'draft');
    await workbench.clear();
    await settings.setConnection(url, token);
    const files = drafts.flatMap(item => item.source.kind === 'file' ? [item.source.file] : []);
    const urls = drafts.flatMap(item => item.source.kind === 'url' ? [item.source.url] : []);
    if (files.length) workbench.addFiles(files);
    if (urls.length) workbench.addUrls(urls);
    await refreshProviders();
    toast(providers.error ? '连接 Server 失败：' + providers.error : 'Server 已保存');
  } catch (error) { toast(errorText(error, '保存连接设置失败')); }
}
//#endregion

//#region 下载与输出重试
async function saveResult(id: string): Promise<void> {
  const item = workbench.items.find(item => item.id === id);
  if (!item || !adapter.value) throw new Error('结果还没生成');
  try {
    const blob = await workbench.resultBlob(id);
    if (!blob) throw new Error('结果还没生成');
    const saved = await saveBlob(adapter.value, blob, resultFilename(item, blob.type));
    if (saved) {
      workbench.clearDownloadFailure(id);
      toast('结果已交给系统保存');
    } else toast('已取消保存，处理结果仍保留');
  } catch (error) {
    workbench.recordDownloadFailure(id, errorText(error, '保存失败'));
    throw error;
  }
}

async function downloadArchive(): Promise<void> {
  if (archiveBusy.value || !workbench.downloadCount || !adapter.value) return;
  archiveBusy.value = true;
  archiveError.value = '';
  archiveController = new AbortController();
  try {
    const archive = await workbench.downloadArchive(archiveController.signal);
    if (archiveController.signal.aborted) return;
    const saved = await saveBlob(adapter.value, archive.blob, archive.filename);
    toast(saved ? 'zip 已交给系统保存' : '已取消保存 zip');
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') toast('已取消打包，处理结果仍保留');
    else archiveError.value = errorText(error, 'zip 下载失败');
  } finally {
    archiveBusy.value = false;
    archiveController = undefined;
  }
}
//#endregion

async function onAction(action: QueueAction, id: string): Promise<void> {
  switch (action) {
    case 'remove': {
      const removed = workbench.items.find(i => i.id === id);
      if (workbench.remove(id) && removed) toast('已移除 ' + (removed.source.kind === 'file' ? removed.source.file.name : removed.source.url));
      return;
    }
    case 'cancel': await workbench.cancel(id); return;
    case 'retry': await workbench.retry(id, 'all'); return;
    case 'retry-outputs':
      if (workbench.downloadFailures[id]) await saveResult(id);
      else await workbench.retry(id, 'outputs');
      return;
    case 'download': await saveResult(id); return;
  }
}
</script>

<template>
  <div class="app" :class="{ 'app--narrow': narrow }">
    <TopBar
      :mode="workbench.mode"
      :provider-label="providerLabel"
      :running="workbench.runningCount"
      :has-running="workbench.hasRunning"
      :network-blocked="workbench.networkBlocked"
      :connection="workbench.connection"
      :narrow="narrow"
      @switch-mode="switchMode"
      @open-inspector="openInspector"
    />
    <p v-if="notice" class="toast" role="status">{{ notice }}</p>

    <div class="mid">
      <AssetRail
        class="area-rail"
        :rows="workbench.queue"
        :selected-id="workbench.selectedItemId"
        :can-add-urls="workbench.canAddUrls"
        :thumbs="visibleThumbs"
        :horizontal="narrow"
        @add-files="chooseFiles"
        @add-urls="addUrls"
        @select="workbench.select"
        @drop="dropFiles"
      />
      <main class="area-canvas">
        <CompareCanvas :item="workbench.selectedItem" :source-url="workbench.selectedItemId ? visibleThumbs[workbench.selectedItemId] : undefined" :result-url="resultUrl" :result-error="previewError" :result-loading="previewLoading" :queue-position="queuePosition" @reload-result="loadPreview">
          <template #empty>
            <div class="drop" @dragover.prevent @drop.prevent="dropFiles(Array.from(($event as DragEvent).dataTransfer?.files ?? []))">
              <h1 class="drop__title">把图片拖到这里</h1>
              <p class="muted">或点击「选择图片」· 单张不超过 20 MB · PNG / JPG / WebP · 加入后不会自动处理</p>
              <div class="drop__actions">
                <button type="button" class="btn" @click="chooseFiles">选择图片</button>
                <button type="button" class="btn" @click="chooseDirectory">选择文件夹</button>
              </div>
            </div>
          </template>
        </CompareCanvas>
      </main>
      <InspectorPanel
        v-if="!narrow"
        class="area-inspector"
        :mode="workbench.mode"
        :pipeline="workbench.pipeline"
        :input-mimes="workbench.inputMimes"
        :cloud-manifests="cloudManifests"
        :conflicts="conflicts"
        :draft-count="workbench.draftCount"
        :running-count="workbench.runningCount"
        :total="workbench.items.length"
        :can-start="canStart"
        :has-running="workbench.hasRunning"
        :server-url="settings.serverUrl"
        :has-token="settings.hasToken"
        :manifest-loading="providers.loading"
        :manifest-error="providers.error"
        :usage-views="usageViews"
        :usage-loading="usage.loading"
        :usage-error="usage.error"
        :pipeline-error="workbench.pipelineError"
        :pipeline-locked="workbench.pipelineLocked"
        @update="updatePipeline"
        @start="start"
        @save-server="saveServer"
        @refresh-usage="refreshUsage"
        @refresh-providers="refreshProviders"
        @switch-cloud="switchMode('cloud')"
      />
    </div>

    <QueuePanel
      v-model:open="queueOpen"
      class="area-queue"
      :rows="workbench.queue"
      :rejected="workbench.rejected"
      :selected-id="workbench.selectedItemId"
      :provider-label="providerLabel"
      :narrow="narrow"
      :has-running="workbench.hasRunning"
      :on-action="onAction"
      :download-count="workbench.downloadCount"
      :archive-busy="archiveBusy"
      :archive-error="archiveError"
      @select="workbench.select"
      @cancel-all="cancelDialogOpen = true"
      @download-archive="downloadArchive"
      @cancel-archive="archiveController?.abort()"
      @clear="workbench.clear"
      @dismiss-rejected="workbench.dismissRejected"
    />

    <footer v-if="narrow" class="footbar">
      <button type="button" class="btn" :disabled="!workbench.downloadCount || archiveBusy" @click="downloadArchive">{{ archiveBusy ? '打包中…' : '⇩ zip (' + workbench.downloadCount + ')' }}</button>
      <button type="button" class="btn btn--primary" :disabled="!canStart" @click="start">▶ 开始处理 ({{ workbench.draftCount }})</button>
      <span class="sr-only" role="status">{{ workbench.pipelineError ?? (conflicts.length ? '当前线路不支持部分操作' : '') }}</span>
    </footer>

    <DialogRoot v-if="narrow" v-model:open="inspectorOpen">
      <DialogPortal>
        <DialogOverlay class="overlay" />
        <DialogContent class="drawer" aria-describedby="" @close-auto-focus="closeDrawerFocus">
          <DialogTitle class="sr-only">操作设置</DialogTitle>
          <DialogClose class="drawer-close" aria-label="关闭操作设置">✕</DialogClose>
          <InspectorPanel
            :mode="workbench.mode"
            :pipeline="workbench.pipeline"
            :input-mimes="workbench.inputMimes"
            :cloud-manifests="cloudManifests"
            :conflicts="conflicts"
            :draft-count="workbench.draftCount"
            :running-count="workbench.runningCount"
            :total="workbench.items.length"
            :can-start="canStart"
            :has-running="workbench.hasRunning"
            :server-url="settings.serverUrl"
            :has-token="settings.hasToken"
            :manifest-loading="providers.loading"
            :manifest-error="providers.error"
            :usage-views="usageViews"
            :usage-loading="usage.loading"
            :usage-error="usage.error"
            :pipeline-error="workbench.pipelineError"
            :pipeline-locked="workbench.pipelineLocked"
            hide-start
            @update="updatePipeline"
            @save-server="saveServer"
            @refresh-usage="refreshUsage"
            @refresh-providers="refreshProviders"
            @switch-cloud="switchMode('cloud')"
          />
        </DialogContent>
      </DialogPortal>
    </DialogRoot>

    <AlertDialogRoot v-model:open="cancelDialogOpen">
      <AlertDialogPortal>
        <AlertDialogOverlay class="overlay" />
        <AlertDialogContent class="confirm">
          <AlertDialogTitle>取消未完成的任务？</AlertDialogTitle>
          <AlertDialogDescription>已完成的结果会保留。已提交给云端的处理可能已经消耗额度。</AlertDialogDescription>
          <div class="confirm-actions">
            <AlertDialogCancel class="btn">继续处理</AlertDialogCancel>
            <AlertDialogAction class="btn btn--danger" @click="cancelAll">取消未完成任务</AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialogPortal>
    </AlertDialogRoot>
  </div>
</template>

<style scoped>
.app { display: grid; grid-template-rows: auto auto minmax(0, 1fr) var(--queue-h); height: 100dvh; min-width: 0; background: var(--paper); }
.mid { display: grid; grid-template-columns: var(--sidebar-w) minmax(0, 1fr) var(--inspector-w); gap: var(--s-3); padding: var(--s-3); min-height: 0; }
.area-canvas { min-width: 0; min-height: 0; }
.area-queue { margin: 0 var(--s-3) var(--s-3); }
.toast { position: fixed; top: 64px; left: 50%; transform: translateX(-50%); z-index: 20; margin: 0; padding: 8px 14px; border-radius: var(--r-md); background: var(--ink); color: var(--accent-ink); box-shadow: var(--shadow-pop); font-size: 13px; }
.drop { display: grid; place-content: center; gap: var(--s-3); height: 100%; margin: var(--s-4); padding: var(--s-6); border: 2px dashed var(--line-strong); border-radius: var(--r-lg); text-align: center; }
.drop__title { margin: 0; font-size: 28px; line-height: 34px; font-weight: 700; letter-spacing: -.03em; }
.drop__actions { display: flex; flex-wrap: wrap; justify-content: center; gap: var(--s-2); }
.muted { margin: 0; color: var(--ink-muted); }
.btn { height: 36px; padding: 0 14px; border: 1px solid var(--line-strong); border-radius: var(--r-md); background: var(--surface); color: var(--ink); cursor: pointer; }
.btn:disabled { opacity: .45; cursor: not-allowed; }
.btn--primary { flex: 1; height: 44px; background: var(--accent); color: var(--accent-ink); border-color: var(--accent); font-weight: 600; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }

@media (min-width: 1024px) and (max-width: 1279px) {
  .mid { grid-template-columns: var(--sidebar-collapsed-w) minmax(0, 1fr) var(--inspector-w); }
  .mid :deep(.rail h3), .mid :deep(.rail .meta), .mid :deep(.rail .adds .btn span) { display: none; }
  .mid :deep(.rail) { padding: 8px; }
  .mid :deep(.rail .adds) { flex-direction: column; }
}

.app--narrow { grid-template-rows: auto auto minmax(0, 1fr) auto auto; }
.app--narrow .mid { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); padding: var(--s-2); gap: var(--s-2); }
.app--narrow .area-queue { margin: 0 var(--s-2); }
.footbar { position: sticky; bottom: 0; display: flex; gap: var(--s-2); padding: var(--s-2) var(--s-2) calc(var(--s-2) + env(safe-area-inset-bottom)); background: var(--surface); border-top: 1px solid var(--line); }
:global(.overlay) { position: fixed; inset: 0; background: rgb(30 41 59 / .35); z-index: 30; }
:global(.drawer) { position: fixed; top: 0; right: 0; bottom: 0; width: min(340px, 100vw); z-index: 31; box-shadow: var(--shadow-pop); }
:global(.drawer > .inspector) { border-radius: 0; }
:global(.drawer-close) { position: absolute; top: 8px; right: 8px; z-index: 1; height: 32px; width: 32px; border: 1px solid var(--line); border-radius: var(--r-sm); background: var(--surface); color: var(--ink); cursor: pointer; }
:global(.drawer > .inspector) { padding-top: 48px; }
:global(.confirm) { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(420px, calc(100vw - 32px)); padding: 24px; border: 1px solid var(--line); border-radius: var(--r-lg); background: var(--surface); color: var(--ink); box-shadow: var(--shadow-pop); z-index: 31; }
.confirm-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
.btn--danger { color: var(--danger); border-color: var(--danger); }
</style>

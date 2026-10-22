<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import LiteIcon from './components/LiteIcon.vue';
import { createLiteSession } from './core/lite/session';
import { formatBytes, sizeChange, statusLabel } from './core/lite/presentation';
import { createShareSession } from './core/share/session';
import { createSettingsSession } from './core/settings/session';
import { createLiteAdapter, createSettingsAdapter, createShareAdapter } from './platform';
import { setLanguage, t } from './core/i18n';
import { connectDesktopEvents, connectShareDrops } from './platform/native';
import { fromBrowserFiles } from './platform/web';

//#region 页面会话与交互
const adapter = createLiteAdapter();
const desktop = adapter.desktop;
const session = createLiteSession(adapter);
const { state, summary } = session;
const dragging = ref(false);
const shareDragging = ref(false);
const filePickingDisabled = computed(() => state.importing || state.clearing);
const startDisabled = computed(() => !desktop || !summary.value.draft || state.clearing);
const saveDisabled = computed(() => !desktop || !summary.value.completed || summary.value.saving || state.clearing);
const overwriteDisabled = computed(() => !desktop || !summary.value.overwritable || summary.value.saving || state.clearing);
const totalChange = computed(() => {
  const difference = summary.value.savedBytes;
  if (!summary.value.completed) return '';
  if (!difference) return t('大小不变');
  return t(difference > 0 ? '共减少 {size}' : '共增加 {size}', {
    size: formatBytes(Math.abs(difference))
  });
});

//#region 双面切换（压缩 / 分享）
type Face = 'compress' | 'share';
function titleFor(next: Face): string {
  return next === 'compress' ? t('shrinkdrop · 图片压缩') : t('File Share · 局域网分享');
}
const face = ref<Face>('compress');
const compressTab = ref<HTMLButtonElement>();
const shareTab = ref<HTMLButtonElement>();
const shareAdapter = createShareAdapter();
const share = createShareSession(shareAdapter);
const settingsAdapter = createSettingsAdapter();
const settings = createSettingsSession(settingsAdapter);
const booting = ref(true);
watch(() => settings.state.view.compression.concurrency, value => session.setConcurrency(value));
watch(() => settings.state.view.compression.autoCompress, value => session.setAutoCompress(value));
const shareState = share.state;
const shareRunning = share.running;
const shareBusy = share.busy;
const shareTotalSize = share.totalSize;
const sharePort = share.port;
const selectedShareIds = ref<number[]>([]);
const downloadBusy = ref(false);
const shareGroupsEl = ref<HTMLElement>();
const downloadableItems = computed(() => shareState.items.filter(item => item.kind !== 'text'));
const selectedShareCount = computed(() => selectedShareIds.value.length);

function isShareSelected(id: number) {
  return selectedShareIds.value.includes(id);
}

function toggleShareSelect(id: number) {
  selectedShareIds.value = isShareSelected(id)
    ? selectedShareIds.value.filter(value => value !== id)
    : [...selectedShareIds.value, id];
}

async function downloadShare(ids: number[]) {
  if (!ids.length || downloadBusy.value) return;
  downloadBusy.value = true;
  const saved = await share.saveItems(ids);
  downloadBusy.value = false;
  if (saved) selectedShareIds.value = selectedShareIds.value.filter(id => !ids.includes(id));
}

function downloadSelected() {
  void downloadShare(selectedShareIds.value);
}

function downloadAll() {
  void downloadShare(downloadableItems.value.map(item => item.id));
}

watch(
  () => [shareState.activeGroup, shareState.items.map(item => item.id).join(',')],
  () => {
    selectedShareIds.value = selectedShareIds.value.filter(id =>
      shareState.items.some(item => item.id === id)
    );
  }
);

const textOpen = ref(false);
const textDraft = ref('');
const textSending = ref(false);
const editingPort = ref(false);
const portDraft = ref(0);

function onGroupsWheel(event: WheelEvent) {
  const element = shareGroupsEl.value;
  if (!element || element.scrollWidth <= element.clientWidth) return;
  if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
  event.preventDefault();
  element.scrollLeft += event.deltaY;
}

function toggleShare() {
  if (shareBusy.value) return;
  if (shareRunning.value) void share.stop();
  else void share.startEmpty();
}

async function submitText() {
  if (!textDraft.value.trim() || textSending.value) return;
  textSending.value = true;
  const ok = await share.addText(textDraft.value);
  textSending.value = false;
  if (ok) {
    textDraft.value = '';
    textOpen.value = false;
  }
}

function startEditPort() {
  portDraft.value = sharePort.value ?? 5421;
  editingPort.value = true;
}

async function savePort() {
  if (!editingPort.value) return;
  const value = Number(portDraft.value);
  editingPort.value = false;
  if (!Number.isInteger(value) || value < 0 || value > 65535 || (value > 0 && value < 1024)) return;
  if (value === sharePort.value) return;
  await settings.update(draft => {
    draft.share.port = value;
  });
}

async function setFace(next: Face) {
  if (face.value === next) return;
  face.value = next;
  void shareAdapter.setTitle(titleFor(next)).catch(() => {});
  void settings.touchFace(next);
  await nextTick();
  (next === 'compress' ? compressTab.value : shareTab.value)?.focus();
}
//#endregion

function onDragOver(event: DragEvent) {
  event.preventDefault();
  if (!desktop && face.value === 'compress') dragging.value = true;
}
function onDragLeave(event: DragEvent) {
  const related = event.relatedTarget;
  if (!desktop && face.value === 'compress' && event.currentTarget instanceof Node
    && !(related instanceof Node && event.currentTarget.contains(related))) dragging.value = false;
}
async function onDrop(event: DragEvent) {
  event.preventDefault(); dragging.value = false;
  if (!desktop && face.value === 'compress') {
    await session.importSources(fromBrowserFiles(Array.from(event.dataTransfer?.files ?? [])));
  }
}

let detached = () => {};
let detachedShare = () => {};
let detachedSettings = () => {};
let detachedShareDrop = () => {};
let unmounted = false;
onMounted(async () => {
  const loaded = await settings.load();
  setLanguage(loaded.general.language);
  session.setConcurrency(loaded.compression.concurrency);
  session.setAutoCompress(loaded.compression.autoCompress);
  face.value = loaded.general.startFace === 'last' ? loaded.general.lastFace : loaded.general.startFace;
  booting.value = false;
  if (settings.adapter.desktop) {
    void settings.adapter.onEvent((event, payload) => {
      if (event === 'changed') void settings.load().then(loaded => { setLanguage(loaded.general.language); void shareAdapter.setTitle(titleFor(face.value)).catch(() => {}); });
      if (event === 'toast' && payload) settings.state.toast = payload;
    }).then(stop => { if (unmounted) stop(); else detachedSettings = stop; });
  }
  void shareAdapter.setTitle(titleFor(face.value)).catch(() => {});
  void share.connect().then(stop => { if (unmounted) stop(); else detachedShare = stop; });
  if (!desktop) return;
  try {
    const stopDrops = await connectShareDrops(paths => {
      shareDragging.value = false;
      if (face.value === 'share') void share.dropPaths(paths);
    });
    if (unmounted) stopDrops(); else detachedShareDrop = stopDrops;
  } catch { /* 拖拽事件不可用时忽略。 */ }
  try {
    const stop = await connectDesktopEvents({
      imported: files => {
        dragging.value = false;
        shareDragging.value = false;
        if (face.value === 'compress') void session.importSources(files, { reportEmpty: true });
      },
      progress: session.updateProgress,
      drag: active => {
        dragging.value = active && face.value === 'compress';
        shareDragging.value = active && face.value === 'share';
      }
    });
    if (unmounted) stop(); else detached = stop;
  } catch { session.notify(t('拖放暂时不可用，请使用「添加图片」选择文件。'), 'error'); }
});
onBeforeUnmount(() => { unmounted = true; detached(); detachedShare(); detachedSettings(); detachedShareDrop(); share.dispose(); void session.dispose(); });
//#endregion
</script>

<template>
  <main class="app-shell" :class="{ 'is-booting': booting }" @dragover="onDragOver" @dragleave="onDragLeave" @drop="onDrop">
    <header class="toolbar">
      <div class="brand">
        <span class="brand-mark"><img src="/app-icon.png" alt="" width="34" height="34" draggable="false" /></span>
        <h1 v-if="face === 'compress'">shrink<span>drop</span></h1>
        <h1 v-else>File <span>Share</span></h1>
      </div>

      <div class="toolbar-end">
        <div class="face-switch" role="tablist" :aria-label="t('切换压缩与分享')"
          @keydown.left.prevent="setFace('compress')" @keydown.right.prevent="setFace('share')">
          <button ref="compressTab" id="face-tab-compress" class="face-tab" role="tab"
            :aria-selected="face === 'compress'" aria-controls="face-compress"
            :tabindex="face === 'compress' ? 0 : -1" @click="setFace('compress')">{{ t('压缩') }}</button>
          <button ref="shareTab" id="face-tab-share" class="face-tab" role="tab"
            :aria-selected="face === 'share'" aria-controls="face-share"
            :tabindex="face === 'share' ? 0 : -1" @click="setFace('share')">{{ t('分享') }}</button>
        </div>

        <div v-if="face === 'compress'" class="import-actions">
          <button class="auto-switch" role="switch" :aria-checked="state.autoCompress"
            :disabled="!desktop || state.clearing" :aria-label="t('上传自动压缩')"
            :title="state.autoCompress ? t('开启后，添加图片就会自动上传压缩') : t('关闭时，添加后需手动开始压缩')"
            @click="session.setAutoCompress(!state.autoCompress)">
            <span>{{ t('上传自动压缩') }}</span><span class="switch-track" aria-hidden="true"><span /></span>
          </button>
          <button class="button" :disabled="filePickingDisabled" @click="session.choose('files')">
            <LiteIcon name="plus" />{{ t('添加图片') }}</button>
          <button class="button" :disabled="filePickingDisabled" @click="session.choose('directory')">
            <LiteIcon name="folder" />{{ t('添加文件夹') }}</button>
        </div>

        <div v-else class="import-actions">
          <template v-if="!shareRunning">
            <button class="button button--primary" :disabled="!desktop || shareBusy" @click="share.pickAndShare()">
              <LiteIcon name="plus" />{{ shareState.phase === 'starting' ? t('正在准备') : t('选择文件') }}
            </button>
          </template>
          <template v-else>
            <button class="button" :disabled="shareState.phase !== 'running' || shareState.adding" @click="share.addFiles()">
              <LiteIcon name="plus" />{{ t('添加文件') }}</button>
            <button class="button button--icon" :disabled="shareState.phase !== 'running' || shareState.adding"
              :aria-label="t('添加文件夹')" :title="t('添加文件夹')" @click="share.addFolder()">
              <LiteIcon name="folder" />
            </button>
            <button class="button" :disabled="shareState.phase !== 'running' || shareState.adding" @click="textOpen = true">
              <LiteIcon name="plus" />{{ t('发文字') }}
            </button>
            <button class="button button--quiet" :disabled="shareState.phase !== 'running'" @click="share.openUploadFolder()">
              <LiteIcon name="folder" />{{ t('接收目录') }}
            </button>
            <button class="button button--quiet" :disabled="shareState.phase === 'stopping'" @click="share.stop()">
              {{ shareState.phase === 'stopping' ? t('正在停止') : t('停止分享') }}
            </button>
          </template>
        </div>

        <button class="icon-button settings-button" :aria-label="t('设置')" :title="t('设置')" @click="settings.open()">
          <LiteIcon name="settings" />
        </button>
      </div>
    </header>

    <div class="flip-stage" :class="{ 'is-share': face === 'share' }">
      <div class="flip-card">
        <section id="face-compress" class="face face--front" role="tabpanel" aria-labelledby="face-tab-compress"
          :inert="face !== 'compress' || undefined" :aria-hidden="face !== 'compress'">
          <div class="face-body">
            <p v-if="!desktop" class="preview-banner" role="note">{{ t('当前为浏览器预览。压缩和保存图片请使用桌面版。') }}</p>
            <div v-if="state.notice" class="notice" :class="`notice--${state.noticeKind}`" role="status" aria-live="polite">
              <span>{{ state.notice }}</span>
              <button class="icon-button" :aria-label="t('关闭提示')" @click="state.notice = ''"><LiteIcon name="close" /></button>
            </div>

            <section class="workspace" :aria-label="t('图片列表')">
              <button
                v-if="!state.items.length" class="drop-zone drop-zone--empty" :class="{ 'is-dragging': dragging }"
                :disabled="filePickingDisabled" @click="session.choose('files')"
              >
                <span class="drop-icon"><LiteIcon name="upload" /></span>
                <strong>{{ dragging ? t('松手即可添加') : desktop ? t('拖入图片或文件夹') : t('拖入图片，或点击添加') }}</strong>
                <span>{{ t('PNG、JPEG、WebP · 单张不超过 20 MB') }}</span>
                <span class="empty-hint">{{ state.autoCompress ? t('自动压缩已开启，添加后立即上传处理') : t('添加后，点击「开始压缩」') }}</span>
              </button>
              <template v-else>
                <button class="drop-zone drop-zone--compact" :class="{ 'is-dragging': dragging }" :disabled="filePickingDisabled" @click="session.choose('files')">
                  <LiteIcon name="plus" /><span>{{ dragging ? t('松手即可添加') : t('拖入更多图片或文件夹') }}</span>
                  <span class="drop-limit">{{ t('单张 ≤ 20 MB') }}</span>
                </button>
                <div class="list-heading" aria-hidden="true"><span>{{ t('图片') }}</span><span>{{ t('原始大小') }}</span><span>{{ t('压缩后') }}</span><span>{{ t('变化') }}</span><span>{{ t('操作') }}</span></div>
                <ul class="image-list" :aria-label="t('待压缩图片')">
                  <li v-for="item in state.items" :key="item.id" class="image-row"
                    :class="{ 'image-row--error': item.status === 'failed' || item.saveError || item.overwriteError,
                      'image-row--busy': item.status === 'processing', 'image-row--stopped': item.status === 'canceled' }"
                    :style="{ '--item-progress': `${item.progress * 100}%` }">
                    <div v-if="item.status !== 'draft'" class="row-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100"
                      :aria-valuenow="item.status === 'completed' ? 100 : undefined"
                      :aria-label="`${item.source.name} ${t('压缩进度')}`" :aria-valuetext="statusLabel(item)" />
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
                    <span class="file-size"><span class="mobile-label">{{ t('原始') }}</span>{{ formatBytes(item.source.size) }}</span>
                    <span class="file-size"><span class="mobile-label">{{ t('压缩后') }}</span>{{ item.result ? formatBytes(item.result.size) : '—' }}</span>
                    <span class="file-change" :class="item.result ? `file-change--${sizeChange(item.source.size, item.result.size).tone}` : ''">
                      {{ item.result ? sizeChange(item.source.size, item.result.size).text : '—' }}
                    </span>
                    <div class="row-actions">
                      <button v-if="item.status === 'queued' || item.status === 'processing'" class="row-button" :disabled="item.cancelPending || state.clearing" :aria-label="`${t('取消')} ${item.source.name}`" @click="session.cancel(item.id)">{{ t('取消') }}</button>
                      <button v-else-if="item.status === 'failed' || item.status === 'canceled'" class="row-button" :disabled="!desktop || state.clearing" :aria-label="`${t('重试')} ${item.source.name}`" @click="session.retry(item.id)"><LiteIcon name="retry" />{{ t('重试') }}</button>
                      <button v-if="item.status === 'completed'" class="row-button row-button--save" :disabled="!desktop || summary.saving || state.clearing" :aria-label="`${item.saveError ? t('重试保存') : t('保存')} ${item.source.name}`" @click="session.save(item.id)">
                        <LiteIcon name="download" />{{ item.saving ? t('保存中') : item.saveError ? t('重试保存') : t('保存') }}
                      </button>
                      <button v-if="item.status === 'completed'" class="row-button row-button--overwrite"
                        :disabled="!desktop || summary.saving || state.clearing || item.overwritten"
                        :aria-label="`${item.overwritten ? t('已覆盖') : item.overwriteError ? t('重试覆盖') : t('覆盖')} ${item.source.name}`"
                        :title="item.overwritten ? t('已用压缩结果覆盖原图') : t('确认后用压缩结果替换原图')"
                        @click="session.overwrite(item.id)"><LiteIcon name="replace" />{{ item.overwriting ? t('覆盖中') : item.overwritten ? t('已覆盖') : t('覆盖') }}</button>
                      <button v-if="item.status !== 'queued' && item.status !== 'processing'" class="icon-button remove-button" :disabled="summary.saving || state.clearing" :aria-label="`${t('移除')} ${item.source.name}`" @click="session.remove(item.id)"><LiteIcon name="close" /></button>
                    </div>
                    <p v-if="item.error || item.cancelError || item.saveError || item.overwriteError" class="row-error" role="status">{{ item.overwriteError || item.saveError || item.error || item.cancelError }}</p>
                  </li>
                </ul>
              </template>
            </section>

            <p class="privacy-note">{{ t('图片会上传至 TinyPNG 进行压缩；除非手动覆盖，原图不会被修改。') }}</p>
            <footer class="footer">
              <div class="summary" aria-live="polite">
                <p><strong>{{ t('{n} 张图片', { n: summary.count }) }}</strong><span v-if="summary.count">{{ formatBytes(summary.originalBytes) }}</span></p>
                <p class="summary-detail">
                  <template v-if="summary.completed || summary.active || summary.failed || summary.canceled">
                    <span v-if="summary.completed">{{ t('{n} 张完成', { n: summary.completed }) }}</span>
                    <span v-if="summary.active">{{ t('{n} 张进行中', { n: summary.active }) }}</span>
                    <span v-if="summary.failed">{{ t('{n} 张失败', { n: summary.failed }) }}</span>
                    <span v-if="summary.canceled">{{ t('{n} 张取消', { n: summary.canceled }) }}</span>
                  </template>
                  <span v-else>{{ summary.count ? t('准备好了，点击开始压缩') : state.autoCompress ? t('添加图片后自动上传压缩') : t('添加图片，开始轻装') }}</span>
                  <span v-if="totalChange" :class="summary.savedBytes < 0 ? 'increased' : 'saved-space'">{{ totalChange }}</span>
                </p>
              </div>
              <div class="footer-actions">
                <button class="button button--quiet" :disabled="!summary.count || summary.saving || state.clearing" @click="session.clear()">{{ state.clearing ? t('正在清空') : t('清空') }}</button>
                <button class="button" :disabled="saveDisabled" @click="session.saveAll()"><LiteIcon name="download" />{{ state.bulkSaving ? t('保存中') : t('保存全部') }}</button>
                <button class="button button--overwrite" :disabled="overwriteDisabled" @click="session.overwriteAll()"><LiteIcon name="replace" />{{ state.bulkOverwriting ? t('覆盖中') : t('批量覆盖') }}</button>
                <button class="button button--primary" :disabled="startDisabled" @click="session.start()">{{ summary.active && !summary.draft ? t('正在压缩') : t('开始压缩') }}<span v-if="summary.draft">{{ summary.draft }}</span></button>
              </div>
            </footer>
          </div>
        </section>

        <section id="face-share" class="face face--back" :class="{ 'is-dragging': shareDragging }" role="tabpanel" aria-labelledby="face-tab-share"
          :inert="face !== 'share' || undefined" :aria-hidden="face !== 'share'">
          <div class="face-body">
            <div v-if="shareDragging" class="share-drop-overlay">{{ t('松手即可添加') }}</div>
            <p v-if="!desktop" class="preview-banner" role="note">{{ t('当前为浏览器预览。局域网分享需要桌面版。') }}</p>

            <div class="share-workspace">
              <div class="share-status">
                <span class="share-dot" :class="{ 'is-on': shareRunning }" aria-hidden="true" />
                <div class="share-copy">
                  <strong>{{ shareRunning ? t('正在分享') : shareBusy ? t('正在准备') : t('分享未开始') }}</strong>
                  <p>{{ shareRunning
                    ? t('已分享 {n} 项，手机扫码即可下载', { n: shareState.items.length })
                    : t('手机与电脑连同一个 Wi-Fi，选择文件或文件夹后扫码下载') }}</p>
                </div>
                <div class="share-status-actions">
                  <button class="share-service-toggle" :class="{ 'is-on': shareRunning }" role="switch" :aria-checked="shareRunning"
                    :disabled="!desktop || shareBusy" @click="toggleShare">
                    <span class="service-dot" aria-hidden="true"></span>
                    <span>{{ shareRunning ? t('分享中') : t('开启服务') }}</span>
                  </button>
                  <span v-if="shareRunning && sharePort" class="share-port">
                    <template v-if="!editingPort">{{ t('端口') }} <button class="port-button" :title="t('端口修改后会重启分享')" @click="startEditPort">{{ sharePort }}</button></template>
                    <input v-else v-model.number="portDraft" class="port-input" type="number" min="0" max="65535"
                      :aria-label="t('端口')" @blur="savePort" @keydown.enter.prevent="savePort" @keydown.esc="editingPort = false" />
                  </span>
                </div>
              </div>

              <p v-if="shareState.error" class="notice notice--error" role="alert">{{ shareState.error }}</p>
              <p v-if="shareState.warning" class="notice" role="note">{{ t(shareState.warning) }}</p>

              <template v-if="shareRunning">
                <div v-if="shareState.groups.length > 1" ref="shareGroupsEl" class="share-groups" role="tablist" :aria-label="t('分组')" @wheel="onGroupsWheel">
                  <button v-for="group in shareState.groups" :key="group.id" type="button" class="share-group-tab"
                    :aria-selected="shareState.activeGroup === group.id" @click="share.setGroup(group.id)">
                    {{ group.id === 'default' ? t('默认分组') : group.name }}<span>{{ group.slug ? `/g/${group.slug}` : t('根路径') }}</span>
                  </button>
                </div>
                <div class="share-link-row">
                  <div class="share-link-copy">
                    <span class="share-label">{{ t('分享链接') }}</span>
                    <p class="share-url" :title="shareState.url">{{ shareState.url }}</p>
                  </div>
                  <div class="share-link-actions">
                    <span class="share-copy-wrap">
                      <button class="button" @click="share.copy()"><LiteIcon name="link" />{{ shareState.copied ? t('已复制') : t('复制链接') }}</button>
                      <span class="share-qr-pop" aria-hidden="true">
                        <span v-if="shareState.qr" v-html="shareState.qr"></span>
                        <span v-else class="share-qr-hint">{{ shareState.qrError ? t('二维码生成失败，请用链接访问') : t('正在生成二维码…') }}</span>
                      </span>
                    </span>
                    <button class="button button--quiet" :disabled="shareState.addresses.length < 2"
                      :title="shareState.addresses.length < 2 ? t('只有一个可用网卡') : t('切换网卡')" @click="share.cycleAddress()">{{ t('切换网卡') }}</button>
                    <button class="button button--quiet" :disabled="!shareState.ipv6Addresses.length"
                      :title="!shareState.ipv6Addresses.length ? t('当前网络没有可用的 IPv6 地址') : 'IPv6'" @click="share.toggleIpv6()">IPv6</button>
                  </div>
                </div>

                <div class="share-body">
                  <div class="share-files">
                    <div v-if="selectedShareCount || downloadableItems.length" class="share-list-head">
                      <div class="share-list-actions">
                        <button v-if="selectedShareCount" class="button button--quiet" :disabled="downloadBusy" @click="downloadSelected">
                          {{ t('下载所选') }} ({{ selectedShareCount }})
                        </button>
                        <button v-if="downloadableItems.length" class="button button--quiet" :disabled="downloadBusy" @click="downloadAll">{{ t('全部下载') }}</button>
                      </div>
                    </div>
                    <ul class="share-list" :aria-label="t('已分享内容')">
                      <li v-for="item in shareState.items" :key="item.id" class="share-row" :class="{ 'share-row--visitor': item.visitor }">
                        <input v-if="item.kind !== 'text'" type="checkbox" class="share-select" :checked="isShareSelected(item.id)"
                          :aria-label="`${t('下载')} ${item.name}`" @change="toggleShareSelect(item.id)" />
                        <span class="share-name" :title="item.kind === 'text' ? item.text || item.name : item.name">
                          <template v-if="item.kind === 'text'">“{{ item.text || item.name }}”</template>
                          <template v-else>{{ item.name }}</template>
                          <em v-if="item.visitor" class="share-badge">{{ t('访客上传') }}</em>
                        </span>
                        <span class="share-size">{{ item.kind === 'dir' ? t('文件夹') : item.kind === 'text' ? t('文字') : formatBytes(item.size) }}</span>
                        <button v-if="item.kind !== 'text'" class="icon-button" :title="t('下载')" :aria-label="`${t('下载')} ${item.name}`" :disabled="downloadBusy" @click="downloadShare([item.id])"><LiteIcon name="download" /></button>
                        <button class="icon-button" :aria-label="`${t('移除')} ${item.name}`" :disabled="!desktop" @click="share.remove(item.id)"><LiteIcon name="close" /></button>
                      </li>
                    </ul>
                    <p v-if="!shareState.items.length" class="share-empty-hint">{{ t('列表已清空，点右上角「添加文件」继续。') }}</p>
                  </div>
                </div>
              </template>

              <div v-else class="drop-zone drop-zone--empty share-empty">
                <span class="drop-icon"><LiteIcon name="upload" /></span>
                <strong>{{ shareBusy ? t('正在准备分享链接') : desktop ? t('打开分享开关开始，或先选择内容') : t('桌面版才能开启分享') }}</strong>
                <span>{{ t('文件或文件夹 · 单次最多 200 项') }}</span>
                <div class="share-empty-actions">
                  <button class="button button--primary" :disabled="!desktop || shareBusy" @click="share.pickAndShare()">
                    <LiteIcon name="plus" />{{ t('选择文件') }}</button>
                  <button class="button" :disabled="!desktop || shareBusy" @click="share.pickAndShareFolder()">
                    <LiteIcon name="folder" />{{ t('选择文件夹') }}
                  </button>
                </div>
                <span class="empty-hint">{{ t('不选文件也可以直接开始分享，链接只在分享期间有效') }}</span>
              </div>
            </div>

            <p class="privacy-note">{{ t('文件只在同一局域网内传输；停止分享后链接立即失效。') }}</p>
            <footer class="footer footer--share">
              <div class="summary" aria-live="polite">
                <p><strong>{{ t('{n} 项', { n: shareState.items.length }) }}</strong><span v-if="shareTotalSize">{{ formatBytes(shareTotalSize) }}</span></p>
                <p class="summary-detail">
                  <span v-if="shareRunning">{{ t('同一 Wi-Fi 下可访问 · 停止后链接失效') }}</span>
                  <span v-else>{{ t('选择内容后自动生成链接与二维码') }}</span>
                </p>
              </div>
            </footer>
          </div>
        </section>
      </div>
    </div>
  </main>

  <div v-if="textOpen" class="settings-overlay" @click.self="textOpen = false">
    <div class="text-sheet" role="dialog" aria-modal="true" aria-labelledby="text-title">
      <h2 id="text-title">{{ t('发文字') }}</h2>
      <textarea v-model="textDraft" maxlength="10000" :placeholder="t('文字内容')" autofocus></textarea>
      <div class="text-sheet-actions">
        <button class="button" @click="textOpen = false">{{ t('取消') }}</button>
        <button class="button button--primary" :disabled="!textDraft.trim() || textSending" @click="submitText">{{ t('发布') }}</button>
      </div>
    </div>
  </div>

  <div v-if="settings.state.toast" class="toast" role="status">
    <span>{{ settings.state.toast }}</span>
    <button class="icon-button" :aria-label="t('关闭提示')" @click="settings.dismissToast()"><LiteIcon name="close" /></button>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { createSettingsSession } from './core/settings/session';
import { createSshSession } from './core/ssh/session';
import { sshCommand, sshErrorMessages } from './core/ssh/messages';
import type { SshLifetime } from './core/ssh/types';
import { createSettingsAdapter, createSshAdapter } from './platform';
import { setLanguage, t } from './core/i18n';
import type { KeepAwake, Language, Permissions, Protection, StartFace } from './core/settings/types';
import { version as appVersion } from '../package.json';

const session = createSettingsSession(createSettingsAdapter());
const sshSession = createSshSession(createSshAdapter());

type Section = 'general' | 'compression' | 'share' | 'ssh' | 'about';
const section = ref<Section>('general');
const view = computed(() => session.state.view);
const ssh = computed(() => sshSession.state.runtime);
const sshSettings = computed(() => sshSession.state.settings);
const sshBusy = computed(() => sshSession.state.busy);
/** Windows 才能改端口；macOS 的 stock Remote Login 由 launchd 固定监听 22。 */
const sshPortEditable = computed(() => ssh.value.platform === 'windows');
const sshConfirming = ref(false);
const sshCopied = ref(false);
const sshErrorCopy = computed(() => {
  if (sshSession.state.detail) return sshSession.state.detail;
  const code = sshSession.state.error;
  return code ? t(sshErrorMessages[code] ?? sshErrorMessages.internal) : '';
});
const sshStateLabel = computed(() => {
  if (!ssh.value.backendAvailable) return t('此版本暂不包含');
  if (!ssh.value.supported) return t('当前系统不支持');
  // 只读路线：状态只来自系统，三态里 unknown 不能显示成“已开启”。
  if (ssh.value.readOnly) {
    if (ssh.value.osState === 'enabled') return t('系统已启用');
    if (ssh.value.osState === 'unknown') return t('无法确认');
    return t('未开启');
  }
  if (!ssh.value.admin) return t('需要管理员账户');
  if (ssh.value.osEnabled && ssh.value.owned) return t('已开启（由 shrinkdrop 管理）');
  if (ssh.value.osEnabled) return t('系统已启用');
  if (ssh.value.listening) return t('监听中');
  return t('未开启');
});
const sshLifetimeHint = computed(() => {
  if (sshSettings.value.lifetime === 'persistent') {
    return t('应用退出后仍然保持开启，重启后也保持。');
  }
  return ssh.value.owned
    ? t('退出应用后自动关闭 SSH，最安全。')
    : t('由 shrinkdrop 开启的 SSH 会在退出应用后关闭；系统已有的实例不受影响。');
});
const sshPortHint = computed(() => {
  const owner = ssh.value.portInUse;
  return owner
    ? t('端口 {port} 已被 {process} (PID {pid}) 占用。', {
        port: owner.port,
        process: owner.process,
        pid: owner.pid
      })
    : '';
});
const sshConnection = computed(() => sshCommand(ssh.value));
/** Windows 缺少 sshd 时的两手准备：只在 FoD/服务缺失的错误上出现。 */
const sshNeedsInstall = computed(
  () =>
    ssh.value.platform === 'windows' &&
    !ssh.value.readOnly &&
    ssh.value.helperInstalled &&
    ssh.value.helperApproved &&
    (sshSession.state.error === 'feature_missing' || sshSession.state.error === 'service_missing')
);
/** 有随包版本时才显示“内置安装”；否则只给官网下载。 */
const sshBundledAvailable = computed(() => Boolean(ssh.value.bundledVersion));
/** 没有辅助服务就没有可审计的特权控制面：开关只读，避免假装可用。 */
const sshToggleBlocked = computed(
  () =>
    !ssh.value.backendAvailable ||
    ssh.value.readOnly ||
    !ssh.value.supported ||
    !ssh.value.admin ||
    !ssh.value.helperInstalled ||
    !ssh.value.helperApproved ||
    sshBusy.value
);
/** 只读路线下只显示“打开共享设置”，不显示生命周期与开关。 */
const sshManual = computed(() => ssh.value.readOnly);
// 防休眠依赖 macOS 的 caffeinate 与 LaunchDaemon，仅在 Mac 上展示该设置。
const isMac = /Mac/i.test(navigator.userAgent);
async function applyWindowTitle() {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().setTitle(`${t('设置')} · shrinkdrop`);
  } catch {
    // 浏览器预览没有窗口标题。
  }
}

onMounted(async () => {
  const loaded = await session.load();
  setLanguage(loaded.general.language);
  void applyWindowTitle();
  void sshSession.load();
  void sshSession.subscribe();
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    // 系统设置/服务管理器可能在本窗口之外改了 SSH，聚焦时重新对齐。
    await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) void sshSession.load();
    });
  } catch {
    // 浏览器预览没有窗口焦点事件。
  }
});
watch(() => view.value.general.language, value => {
  setLanguage(value);
  void applyWindowTitle();
});
const pinInput = ref('');
const accountName = ref('');
const accountPassword = ref('');
const accountPermissions = ref<Permissions>({ download: true, upload: false, text: false });
const groupName = ref('');
const groupSlug = ref('');
const groupPins = reactive<Record<string, string>>({});

async function closeWindow() {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('settings_close');
  } catch {
    window.close();
  }
}

function update(mutator: (draft: typeof view.value) => void) {
  void session.update(mutator);
}

function setStartFace(event: Event) {
  const value = (event.target as HTMLSelectElement).value as StartFace;
  update(draft => { draft.general.startFace = value; });
}

function changeLanguage(event: Event) {
  const value = (event.target as HTMLSelectElement).value as Language;
  update(draft => { draft.general.language = value; });
}

function setAutoCompress(event: Event) {
  const checked = (event.target as HTMLInputElement).checked;
  update(draft => { draft.compression.autoCompress = checked; });
}

function setKeepAwake(level: KeepAwake) {
  if (view.value.general.keepAwake === level) return;
  update(draft => { draft.general.keepAwake = level; });
}

const keepAwakeOptions = computed(() => [
  { value: 'off' as KeepAwake, label: t('关闭') },
  { value: 'idle' as KeepAwake, label: t('空闲不休眠') },
  { value: 'always' as KeepAwake, label: t('彻底不休眠') }
]);

const keepAwakeHint = computed(() => {
  switch (view.value.general.keepAwake) {
    case 'idle':
      return t('阻止系统空闲休眠，屏幕仍会按节能设置关闭；适合有人在旁边扫码下载。');
    case 'always':
      return t('同时阻止空闲与合盖休眠。合盖需要管理员授权修改系统电源设置，退出应用或切回其它档位时自动恢复。');
    default:
      return t('按系统节能设置休眠；合盖后局域网分享会中断。');
  }
});

function setConcurrency(event: Event) {
  const value = Number((event.target as HTMLInputElement).value);
  if (!Number.isInteger(value) || value < 1 || value > 5) return;
  update(draft => { draft.compression.concurrency = value; });
}

function setPort(event: Event) {
  const value = Number((event.target as HTMLInputElement).value);
  if (!Number.isInteger(value) || value < 0 || value > 65535 || (value > 0 && value < 1024)) return;
  update(draft => { draft.share.port = value; });
}

function setProtection(value: Protection) {
  update(draft => { draft.share.protection = value; });
}

function setPublic(event: Event) {
  const checked = (event.target as HTMLInputElement).checked;
  update(draft => { draft.share.public = checked; });
}

function setAllowUpload(event: Event) {
  const checked = (event.target as HTMLInputElement).checked;
  update(draft => { draft.share.allowUpload = checked; });
}

function setAutoSaveUploads(event: Event) {
  const checked = (event.target as HTMLInputElement).checked;
  update(draft => { draft.share.autoSaveUploads = checked; });
}

function setAllowFolderUpload(event: Event) {
  const checked = (event.target as HTMLInputElement).checked;
  update(draft => { draft.share.allowFolderUpload = checked; });
}

function setAllowText(event: Event) {
  const checked = (event.target as HTMLInputElement).checked;
  update(draft => { draft.share.allowText = checked; });
}

function clearSaveDir() {
  update(draft => { draft.compression.saveDir = null; });
}

function clearUploadDir() {
  update(draft => { draft.share.uploadDir = null; });
}

function savePin() {
  const pin = pinInput.value.trim();
  if (!/^\d{6}$/.test(pin)) return;
  void session.setPin(pin);
  pinInput.value = '';
}

function clearPin() {
  void session.setPin(null);
}

function addAccount() {
  if (!accountName.value.trim() || accountPassword.value.length < 4) return;
  void session.addAccount(accountName.value, accountPassword.value, accountPermissions.value);
  accountName.value = '';
  accountPassword.value = '';
  accountPermissions.value = { download: true, upload: false, text: false };
}

function togglePermission(id: string, key: keyof Permissions, event: Event) {
  const checked = (event.target as HTMLInputElement).checked;
  const account = view.value.share.accounts.find(item => item.id === id);
  if (!account) return;
  void session.updateAccount(id, {
    permissions: { ...account.permissions, [key]: checked }
  });
}

function toggleEnabled(id: string, event: Event) {
  void session.updateAccount(id, { enabled: (event.target as HTMLInputElement).checked });
}

function removeAccount(id: string) {
  void session.deleteAccount(id);
}

function normalizeSlug(value: string): string | null {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return slug.length >= 2 ? slug : null;
}

function addGroup() {
  if (!groupName.value.trim()) return;
  const slug = normalizeSlug(groupSlug.value);
  void session.addGroup(groupName.value.trim(), slug);
  groupName.value = '';
  groupSlug.value = '';
}

function removeGroup(id: string) {
  void session.deleteGroup(id);
}

function setGroupProtection(group: { id: string; public: boolean; allowUpload: boolean; allowText: boolean }, event: Event) {
  const protection = (event.target as HTMLSelectElement).value as Protection;
  void session.updateGroupAccess(group.id, {
    public: group.public,
    protection,
    allowUpload: group.allowUpload,
    allowText: group.allowText
  });
}

function setGroupPublic(group: { id: string; protection: Protection; allowUpload: boolean; allowText: boolean }, event: Event) {
  const checked = (event.target as HTMLInputElement).checked;
  void session.updateGroupAccess(group.id, {
    public: checked,
    protection: group.protection,
    allowUpload: group.allowUpload,
    allowText: group.allowText
  });
}

function setGroupAllow(group: { id: string; public: boolean; protection: Protection; allowUpload: boolean; allowText: boolean }, key: 'allowUpload' | 'allowText', event: Event) {
  const checked = (event.target as HTMLInputElement).checked;
  void session.updateGroupAccess(group.id, {
    public: group.public,
    protection: group.protection,
    allowUpload: key === 'allowUpload' ? checked : group.allowUpload,
    allowText: key === 'allowText' ? checked : group.allowText
  });
}

function saveGroupPin(group: { id: string }) {
  const pin = (groupPins[group.id] ?? '').trim();
  if (!/^\d{6}$/.test(pin)) return;
  void session.setGroupPin(group.id, pin);
  groupPins[group.id] = '';
}

function clearGroupPin(group: { id: string }) {
  void session.setGroupPin(group.id, null);
}

function toggleSsh(event: Event) {
  const checked = (event.target as HTMLInputElement).checked;
  if (!checked) {
    sshConfirming.value = false;
    void sshSession.disable();
    return;
  }
  // 首次开启不直接调特权接口：先说明系统账户/局域网暴露，再让用户确认。
  sshConfirming.value = true;
}

function confirmSshEnable() {
  sshConfirming.value = false;
  void sshSession.enable(sshSettings.value.lifetime, sshSettings.value.port);
}

function setSshLifetime(lifetime: SshLifetime) {
  if (sshSettings.value.lifetime === lifetime) return;
  void sshSession.setLifetime(lifetime);
}

function setSshPort(event: Event) {
  const value = Number((event.target as HTMLInputElement).value);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    (event.target as HTMLInputElement).value = String(sshSettings.value.port);
    return;
  }
  void sshSession.setPort(value);
}

async function copySshConnection() {
  try {
    await navigator.clipboard.writeText(sshConnection.value);
    sshCopied.value = true;
    setTimeout(() => {
      sshCopied.value = false;
    }, 1500);
  } catch {
    // 没有剪贴板权限时保持原文可选，由用户手动复制。
  }
}

</script>

<template>
  <div class="settings-window">
        <div class="settings-main">
          <nav class="settings-nav" :aria-label="t('设置分组')">
            <button class="settings-tab" :aria-current="section === 'general'" @click="section = 'general'">{{ t('通用') }}</button>
            <button class="settings-tab" :aria-current="section === 'compression'" @click="section = 'compression'">{{ t('压缩') }}</button>
            <button class="settings-tab" :aria-current="section === 'share'" @click="section = 'share'">{{ t('分享') }}</button>
            <button class="settings-tab" :aria-current="section === 'ssh'" @click="section = 'ssh'">{{ t('远程访问') }}</button>
            <button class="settings-tab" :aria-current="section === 'about'" @click="section = 'about'">{{ t('关于') }}</button>
          </nav>

          <div class="settings-body">
            <p v-if="session.state.error" class="notice notice--error" role="alert">{{ session.state.error }}</p>

            <section v-if="section === 'general'" class="settings-section">
              <label class="settings-row">
                <span>{{ t('启动时显示') }}</span>
                <select :value="view.general.startFace" @change="setStartFace">
                  <option value="last">{{ t('上次使用') }}</option>
                  <option value="compress">{{ t('压缩') }}</option>
                  <option value="share">{{ t('分享') }}</option>
                </select>
              </label>
              <label class="settings-row">
                <span>{{ t('语言') }}</span>
                <select :value="view.general.language" @change="changeLanguage">
                  <option value="auto">{{ t('跟随系统') }}</option>
                  <option value="zh">中文</option>
                  <option value="en">English</option>
                </select>
              </label>
              <p class="settings-hint">{{ t('语言修改会立即同步到桌面端与访客页。') }}</p>
              <div v-if="isMac" class="settings-row settings-row--switch">
                <span>{{ t('防休眠') }}</span>
                <div class="keep-awake-steps" role="radiogroup" :aria-label="t('防休眠')">
                  <button v-for="option in keepAwakeOptions" :key="option.value" type="button" role="radio"
                    class="keep-awake-step" :aria-checked="view.general.keepAwake === option.value"
                    :class="{ 'is-active': view.general.keepAwake === option.value }"
                    @click="setKeepAwake(option.value)">{{ option.label }}</button>
                </div>
              </div>
              <p v-if="isMac" class="settings-hint">{{ keepAwakeHint }}</p>
              <p v-if="isMac && view.general.keepAwake === 'always'" class="settings-hint settings-hint--warning" role="note">
                {{ t('彻底不休眠会更耗电：屏幕常亮、风扇与网络持续工作，笔记本合盖放进包里仍会发热。用完请及时切回「关闭」或退出应用。') }}
              </p>
            </section>

            <section v-else-if="section === 'compression'" class="settings-section">
              <div class="settings-row settings-row--switch">
                <span>{{ t('默认开启「上传自动压缩」') }}</span>
                <label class="switch">
                  <input type="checkbox" :checked="view.compression.autoCompress" @change="setAutoCompress" />
                  <span class="switch-track" aria-hidden="true"><span /></span>
                </label>
              </div>
              <label class="settings-row">
                <span>{{ t('同时处理图片数') }}</span>
                <input class="settings-number" type="number" min="1" max="5" :value="view.compression.concurrency" @change="setConcurrency" />
              </label>
              <div class="settings-row">
                <span>{{ t('保存目录') }}</span>
                <div class="settings-path-row">
                  <span class="settings-path">{{ view.compression.saveDir || t('未设置（每次询问）') }}</span>
                  <button class="button" @click="session.pickDirectory('save')">{{ t('选择') }}</button>
                  <button v-if="view.compression.saveDir" class="button button--quiet" @click="clearSaveDir">{{ t('清除') }}</button>
                </div>
              </div>
            </section>

            <section v-else-if="section === 'share'" class="settings-section">
              <label class="settings-row">
                <span>{{ t('端口') }}</span>
                <input class="settings-number" type="number" min="0" max="65535" :value="view.share.port" @change="setPort" />
              </label>
              <p class="settings-hint">{{ t('0 表示自动：优先 5421，被占用时退回随机端口。') }}</p>

              <div class="settings-row">
                <span>{{ t('接收上传的目录') }}</span>
                <div class="settings-path-row">
                  <span class="settings-path">{{ view.share.uploadDir || '~/Downloads/shrinkdrop Share' }}</span>
                  <button class="button" @click="session.pickDirectory('upload')">{{ t('选择') }}</button>
                  <button v-if="view.share.uploadDir" class="button button--quiet" @click="clearUploadDir">{{ t('清除') }}</button>
                </div>
              </div>

              <div class="settings-row settings-row--stack">
                <span>{{ t('访问保护') }}</span>
                <div class="settings-choices">
                  <label><input type="radio" name="protection" :checked="view.share.protection === 'link'" @change="setProtection('link')" />{{ t('链接访问') }}</label>
                  <label><input type="radio" name="protection" :checked="view.share.protection === 'pin'" @change="setProtection('pin')" />{{ t('链接 + PIN') }}</label>
                  <label><input type="radio" name="protection" :checked="view.share.protection === 'accounts'" @change="setProtection('accounts')" />{{ t('账号登录') }}</label>
                </div>
              </div>

              <div v-if="view.share.protection === 'pin'" class="settings-block">
                <p class="settings-hint">{{ view.share.pinSet ? t('已设置 PIN，修改后访客需要重新解锁。') : t('还没有设置 PIN。') }}</p>
                <div class="settings-inline">
                  <input v-model="pinInput" class="settings-number" inputmode="numeric" maxlength="6" :placeholder="t('6 位数字')" />
                  <button class="button" :disabled="!/^\d{6}$/.test(pinInput)" @click="savePin">{{ t('保存 PIN') }}</button>
                  <button v-if="view.share.pinSet" class="button button--quiet" @click="clearPin">{{ t('清除') }}</button>
                </div>
              </div>

              <div v-if="view.share.protection === 'accounts'" class="settings-block">
                <ul class="settings-accounts">
                  <li v-for="account in view.share.accounts" :key="account.id" class="settings-account">
                    <div class="settings-account-head">
                      <span class="settings-account-name">
                        <strong>{{ account.username }}</strong>
                        <span class="settings-account-password">{{ account.password }}</span>
                      </span>
                      <label class="settings-mini"><input type="checkbox" :checked="account.enabled" @change="toggleEnabled(account.id, $event)" />{{ t('启用') }}</label>
                      <button class="button button--quiet" @click="removeAccount(account.id)">{{ t('删除') }}</button>
                    </div>
                    <div class="settings-perms">
                      <label><input type="checkbox" :checked="account.permissions.download" @change="togglePermission(account.id, 'download', $event)" />{{ t('下载') }}</label>
                      <label><input type="checkbox" :checked="account.permissions.upload" @change="togglePermission(account.id, 'upload', $event)" />{{ t('上传') }}</label>
                      <label><input type="checkbox" :checked="account.permissions.text" @change="togglePermission(account.id, 'text', $event)" />{{ t('文字') }}</label>
                    </div>
                  </li>
                </ul>
                <p v-if="!view.share.accounts.length" class="settings-hint">{{ t('还没有账号，添加后访客需要登录。') }}</p>

                <div class="settings-account-add">
                  <input v-model="accountName" :placeholder="t('用户名')" maxlength="32" />
                  <input v-model="accountPassword" type="password" :placeholder="t('密码（至少 4 位）')" />
                  <div class="settings-perms">
                    <label><input v-model="accountPermissions.download" type="checkbox" />{{ t('下载') }}</label>
                    <label><input v-model="accountPermissions.upload" type="checkbox" />{{ t('上传') }}</label>
                    <label><input v-model="accountPermissions.text" type="checkbox" />{{ t('文字') }}</label>
                  </div>
                  <button class="button" :disabled="!accountName.trim() || accountPassword.length < 4" @click="addAccount">{{ t('添加账号') }}</button>
                </div>
              </div>

              <div v-if="view.share.protection !== 'accounts'" class="settings-block">
                <div v-if="view.share.protection === 'link'" class="settings-row settings-row--switch">
                  <span>{{ t('允许公开访问') }}</span>
                  <label class="switch">
                    <input type="checkbox" :checked="view.share.public" @change="setPublic" />
                    <span class="switch-track" aria-hidden="true"><span /></span>
                  </label>
                </div>
                <div class="settings-row settings-row--switch">
                  <span>{{ t('允许访客上传文件') }}</span>
                  <label class="switch">
                    <input type="checkbox" :checked="view.share.allowUpload" @change="setAllowUpload" />
                    <span class="switch-track" aria-hidden="true"><span /></span>
                  </label>
                </div>
                <div class="settings-row settings-row--switch">
                  <span>{{ t('允许访客发布文字') }}</span>
                  <label class="switch">
                    <input type="checkbox" :checked="view.share.allowText" @change="setAllowText" />
                    <span class="switch-track" aria-hidden="true"><span /></span>
                  </label>
                </div>
              </div>
              <div class="settings-row settings-row--switch">
                <span>{{ t('允许访客上传文件夹') }}</span>
                <label class="switch"><input type="checkbox" :checked="view.share.allowFolderUpload" :aria-label="t('允许访客上传文件夹')" @change="setAllowFolderUpload" /><span class="switch-track" aria-hidden="true"><span /></span></label>
              </div>
              <p class="settings-hint">{{ t('需要访客拥有上传权限，文件夹内的目录结构会保留。') }}</p>
              <div class="settings-row settings-row--switch">
                <span>{{ t('上传后自动保存到下载目录') }}</span>
                <label class="switch"><input type="checkbox" :checked="view.share.autoSaveUploads" @change="setAutoSaveUploads" /><span class="switch-track" aria-hidden="true"><span /></span></label>
              </div>
              <p class="settings-hint">{{ t('开启后上传直接保存到下载目录，不再额外写入接收目录。') }}</p>
              <div class="settings-block">
                <span>{{ t('分组') }}</span>
                <p class="settings-hint">{{ t('默认分组在根路径；自定义分组在 /g/路径，文件互不共享，可独立设置访问保护。') }}</p>
                <ul class="settings-accounts">
                  <li v-for="group in view.share.groups" :key="group.id" class="settings-account">
                    <div class="settings-account-head">
                      <span class="settings-account-name"><strong>{{ group.name }}</strong><span class="settings-account-password">/g/{{ group.slug }}</span></span>
                      <button class="button button--quiet" @click="removeGroup(group.id)">{{ t('删除') }}</button>
                    </div>
                    <div class="settings-row">
                      <span>{{ t('访问保护') }}</span>
                      <select :value="group.protection" @change="setGroupProtection(group, $event)">
                        <option value="link">{{ t('链接访问') }}</option>
                        <option value="pin">{{ t('链接 + PIN') }}</option>
                        <option value="accounts">{{ t('账号登录') }}</option>
                      </select>
                    </div>
                    <div v-if="group.protection === 'link'" class="settings-row settings-row--switch">
                      <span>{{ t('允许公开访问') }}</span>
                      <label class="switch"><input type="checkbox" :checked="group.public" @change="setGroupPublic(group, $event)" /><span class="switch-track" aria-hidden="true"><span /></span></label>
                    </div>
                    <div class="settings-row settings-row--switch">
                      <span>{{ t('允许访客上传文件') }}</span>
                      <label class="switch"><input type="checkbox" :checked="group.allowUpload" @change="setGroupAllow(group, 'allowUpload', $event)" /><span class="switch-track" aria-hidden="true"><span /></span></label>
                    </div>
                    <div class="settings-row settings-row--switch">
                      <span>{{ t('允许访客发布文字') }}</span>
                      <label class="switch"><input type="checkbox" :checked="group.allowText" @change="setGroupAllow(group, 'allowText', $event)" /><span class="switch-track" aria-hidden="true"><span /></span></label>
                    </div>
                    <div v-if="group.protection === 'pin'" class="settings-inline">
                      <input v-model="groupPins[group.id]" class="settings-number" inputmode="numeric" maxlength="6" :placeholder="t('6 位数字')" />
                      <button class="button" :disabled="!/^\d{6}$/.test(groupPins[group.id] ?? '')" @click="saveGroupPin(group)">{{ t('保存 PIN') }}</button>
                      <button v-if="group.pinSet" class="button button--quiet" @click="clearGroupPin(group)">{{ t('清除') }}</button>
                    </div>
                    <p class="settings-hint">{{ group.pinSet ? t('已设置 PIN，修改后访客需要重新解锁。') : t('还没有设置 PIN。') }}</p>
                  </li>
                </ul>
                <p v-if="!view.share.groups.length" class="settings-hint">{{ t('还没有自定义分组，默认分组始终可用。') }}</p>
                <div class="settings-account-add">
                  <input v-model="groupName" :placeholder="t('分组名称')" maxlength="32" />
                  <input v-model="groupSlug" :placeholder="t('路径（留空随机，仅小写字母/数字/短横线）')" maxlength="32" />
                  <button class="button" :disabled="!groupName.trim()" @click="addGroup">{{ t('添加分组') }}</button>
                </div>
              </div>
              <p v-if="view.share.protection === 'link'" class="settings-hint">{{ t('未开启公开访问时，链接模式下的访客无法打开分享。') }}</p>
              <p class="settings-hint">{{ t('分享运行中修改端口或保护方式会自动重启服务，旧链接随即失效。') }}</p>
            </section>

            <section v-else-if="section === 'ssh'" class="settings-section">
              <template v-if="sshManual">
                <div class="settings-row">
                  <span>{{ t('允许通过 SSH 远程登录本机') }}</span>
                  <button class="button" @click="sshSession.openSharingSettings()">{{ t('打开共享设置') }}</button>
                </div>
                <p class="settings-hint">{{ t('macOS 的远程登录由系统设置管理：打开「共享 → 远程登录」开启一次即可，应用只读取状态。') }}</p>
              </template>
              <template v-else>
              <div class="settings-row settings-row--switch">
                <span>{{ t('允许通过 SSH 远程登录本机') }}</span>
                <label class="switch">
                  <input
                    type="checkbox"
                    role="switch"
                    :checked="sshSettings.enabled || sshConfirming"
                    :disabled="sshToggleBlocked"
                    :aria-label="t('允许通过 SSH 远程登录本机')"
                    @change="toggleSsh"
                  />
                  <span class="switch-track" aria-hidden="true"><span /></span>
                </label>
              </div>
              <p class="settings-hint">{{ t('开启后，局域网内的设备可以用系统账户通过 SSH 连接这台电脑。') }}</p>

              <div v-if="sshConfirming" class="settings-block" role="alertdialog" :aria-label="t('确认开启远程访问？')">
                <p><strong>{{ t('确认开启远程访问？') }}</strong></p>
                <p class="settings-hint">{{ t('这会把这台电脑的 SSH 端口暴露到局域网，并使用系统账户登录。可以随时关闭。') }}</p>
                <div class="settings-inline">
                  <button class="button button--primary" @click="confirmSshEnable">{{ t('确认开启') }}</button>
                  <button class="button button--quiet" @click="sshConfirming = false">{{ t('取消') }}</button>
                </div>
              </div>

              <div class="settings-row settings-row--stack">
                <span>{{ t('生命周期') }}</span>
                <div class="settings-choices">
                  <label><input type="radio" name="ssh-lifetime" :checked="sshSettings.lifetime === 'app'" :disabled="sshBusy" @change="setSshLifetime('app')" />{{ t('仅应用运行时') }}</label>
                  <label><input type="radio" name="ssh-lifetime" :checked="sshSettings.lifetime === 'persistent'" :disabled="sshBusy" @change="setSshLifetime('persistent')" />{{ t('后台常驻') }}</label>
                </div>
              </div>
              <p class="settings-hint">{{ sshLifetimeHint }}</p>
              </template>

              <div class="settings-row">
                <span>{{ t('端口') }}</span>
                <input
                  v-if="sshPortEditable"
                  class="settings-number"
                  type="number"
                  min="1"
                  max="65535"
                  :value="sshSettings.port"
                  :aria-label="t('端口')"
                  @change="setSshPort"
                />
                <span v-else class="settings-path">{{ sshSettings.port }}</span>
              </div>
              <p class="settings-hint">{{ sshPortEditable ? t('Windows 可以自定义端口；修改会断开现有 SSH 会话。') : t('macOS 的系统远程登录固定使用 22 端口。') }}</p>

              <div class="settings-block">
                <div class="settings-row">
                  <span>{{ t('状态') }}</span>
                  <strong>{{ sshStateLabel }}</strong>
                </div>
                <p v-if="sshPortHint" class="settings-hint settings-hint--warning" role="note">{{ sshPortHint }}</p>
                <p v-if="sshErrorCopy" class="notice notice--error" role="alert">{{ sshErrorCopy }}</p>
                <p v-if="!ssh.backendAvailable" class="settings-hint">{{ t('此版本暂不包含远程访问控制面，需要带辅助服务的签名版本。') }}</p>
                <p v-else-if="sshManual" class="settings-hint">{{ t('状态由系统设置管理，应用只读；开启或关闭请到「共享 → 远程登录」。') }}</p>
                <template v-else>
                  <p v-if="!ssh.helperInstalled" class="settings-hint">{{ t('需要安装辅助服务才能开启远程访问。') }}</p>
                  <p v-else-if="!ssh.helperApproved" class="settings-hint settings-hint--warning" role="note">{{ t('辅助服务等待系统批准：在「登录项」里允许 shrinkdrop 后重试。') }}</p>
                  <div v-if="ssh.supported && ssh.admin" class="settings-inline">
                    <button v-if="!ssh.helperInstalled" class="button" :disabled="sshBusy" @click="sshSession.installHelper()">{{ t('安装辅助服务') }}</button>
                    <button v-else class="button button--quiet" :disabled="sshBusy" @click="sshSession.uninstallHelper()">{{ t('卸载辅助服务') }}</button>
                  </div>
                  <p v-if="ssh.supported && ssh.admin" class="settings-hint">{{ ssh.helperInstalled ? t('卸载辅助服务会同时关闭由 shrinkdrop 开启的 SSH。') : t('安装辅助服务需要管理员授权（系统密码或 UAC）。') }}</p>
                </template>
                <p v-if="ssh.supported && !ssh.admin" class="settings-hint settings-hint--warning">{{ t('SSH 需要管理员账户，请用管理员账户打开应用。') }}</p>
                <template v-if="sshNeedsInstall">
                  <p class="settings-hint settings-hint--warning" role="note">{{ t('系统未安装 OpenSSH Server。可以先去 Windows 设置 → 可选功能里安装，或使用下面两种兜底。') }}</p>
                  <div class="settings-inline">
                    <button class="button" :disabled="sshBusy" @click="sshSession.openOpenSshDownload()">{{ t('官网下载') }}</button>
                    <button v-if="sshBundledAvailable" class="button button--primary" :disabled="sshBusy" @click="sshSession.installBundledOpenSsh()">{{ t('内置安装（随包 OpenSSH）') }}</button>
                  </div>
                  <p v-if="sshBundledAvailable" class="settings-hint">{{ t('内置版本 {version}；安装前校验 SHA256，不会静默安装。', { version: ssh.bundledVersion ?? '' }) }}</p>
                  <p class="settings-hint">{{ t('安装完成后回到这里重新开启；如果系统提示重启，请先重启。') }}</p>
                </template>
              </div>

              <div v-if="ssh.backendAvailable" class="settings-block">
                <div class="settings-row">
                  <span>{{ t('连接命令') }}</span>
                  <div class="settings-path-row">
                    <code class="settings-path">{{ sshConnection }}</code>
                    <button class="button" @click="copySshConnection">{{ sshCopied ? t('已复制') : t('复制') }}</button>
                  </div>
                </div>
                <p v-if="ssh.fingerprint" class="settings-hint">{{ t('主机指纹') }}：{{ ssh.fingerprint }}</p>
                <p class="settings-hint">{{ t('仅建议在可信局域网内开启，优先使用公钥登录。') }}</p>
                <p class="settings-hint">{{ t('睡眠或 FileVault 未解锁时无法连接。') }}</p>
              </div>
            </section>

            <section v-else class="settings-section">
              <p><strong>shrinkdrop / File Share</strong> {{ appVersion }}</p>
              <p class="settings-hint">{{ t('设置保存在应用配置目录；PIN 使用哈希，账号口令明文保存在本地。') }}</p>
              <p class="settings-hint">{{ t('压缩使用匿名 TinyPNG 接口；分享服务只在同一个 Tauri 进程内运行。') }}</p>
            </section>
          </div>
        </div>

        <footer class="settings-foot">
          <span class="settings-hint">{{ session.state.saving ? t('正在保存…') : t('修改后立即生效') }}</span>
          <button class="button button--primary" @click="closeWindow">{{ t('完成') }}</button>
    </footer>
  </div>
</template>

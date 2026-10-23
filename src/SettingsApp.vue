<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { createSettingsSession } from './core/settings/session';
import { createSettingsAdapter } from './platform';
import { setLanguage, t } from './core/i18n';
import type { Language, Permissions, Protection, StartFace } from './core/settings/types';
import { version as appVersion } from '../package.json';

const session = createSettingsSession(createSettingsAdapter());

type Section = 'general' | 'compression' | 'share' | 'about';
const section = ref<Section>('general');
const view = computed(() => session.state.view);
// 防休眠依赖 macOS 的 caffeinate，仅在 Mac 上展示该开关。
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

function setKeepAwake(event: Event) {
  const checked = (event.target as HTMLInputElement).checked;
  update(draft => { draft.general.keepAwake = checked; });
}

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

</script>

<template>
  <div class="settings-window">
        <div class="settings-main">
          <nav class="settings-nav" :aria-label="t('设置分组')">
            <button class="settings-tab" :aria-current="section === 'general'" @click="section = 'general'">{{ t('通用') }}</button>
            <button class="settings-tab" :aria-current="section === 'compression'" @click="section = 'compression'">{{ t('压缩') }}</button>
            <button class="settings-tab" :aria-current="section === 'share'" @click="section = 'share'">{{ t('分享') }}</button>
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
                <span>{{ t('合盖不休眠') }}</span>
                <label class="switch">
                  <input type="checkbox" :checked="view.general.keepAwake" @change="setKeepAwake" />
                  <span class="switch-track" aria-hidden="true"><span /></span>
                </label>
              </div>
              <p v-if="isMac" class="settings-hint">{{ t('开启后使用系统防休眠，笔记本合盖或空闲时不会进入睡眠；关闭应用或此开关即恢复。') }}</p>
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
                <span>{{ t('上传后自动保存到下载目录') }}</span>
                <label class="switch"><input type="checkbox" :checked="view.share.autoSaveUploads" @change="setAutoSaveUploads" /><span class="switch-track" aria-hidden="true"><span /></span></label>
              </div>
              <p class="settings-hint">{{ t('默认手动：访客上传的文件只在列表中高亮，由你选择保存；开启后会自动复制到系统下载目录。') }}</p>
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

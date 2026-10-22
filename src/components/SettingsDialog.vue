<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { SettingsSession } from '../core/settings/session';
import type { Permissions, Protection, StartFace, VisitorLang } from '../core/settings/types';

const props = defineProps<{ session: SettingsSession; open: boolean }>();
const emit = defineEmits<{ close: [] }>();

type Section = 'general' | 'compression' | 'share' | 'about';
const section = ref<Section>('general');
const view = computed(() => props.session.state.view);
const closeButton = ref<HTMLButtonElement>();
const pinInput = ref('');
const accountName = ref('');
const accountPassword = ref('');
const accountPermissions = ref<Permissions>({ download: true, upload: false, text: false });

function update(mutator: (draft: typeof view.value) => void) {
  void props.session.update(mutator as never);
}

function setStartFace(event: Event) {
  const value = (event.target as HTMLSelectElement).value as StartFace;
  update(draft => { draft.general.startFace = value; });
}

function setVisitorLang(event: Event) {
  const value = (event.target as HTMLSelectElement).value as VisitorLang;
  update(draft => { draft.general.visitorLang = value; });
}

function setAutoCompress(event: Event) {
  const checked = (event.target as HTMLInputElement).checked;
  update(draft => { draft.compression.autoCompress = checked; });
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

function setAllowUpload(event: Event) {
  const checked = (event.target as HTMLInputElement).checked;
  update(draft => { draft.share.allowUpload = checked; });
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
  void props.session.setPin(pin);
  pinInput.value = '';
}

function clearPin() {
  void props.session.setPin(null);
}

function addAccount() {
  if (!accountName.value.trim() || accountPassword.value.length < 4) return;
  void props.session.addAccount(accountName.value, accountPassword.value, accountPermissions.value);
  accountName.value = '';
  accountPassword.value = '';
  accountPermissions.value = { download: true, upload: false, text: false };
}

function togglePermission(id: string, key: keyof Permissions, event: Event) {
  const checked = (event.target as HTMLInputElement).checked;
  const account = view.value.share.accounts.find(item => item.id === id);
  if (!account) return;
  void props.session.updateAccount(id, {
    permissions: { ...account.permissions, [key]: checked }
  });
}

function toggleEnabled(id: string, event: Event) {
  void props.session.updateAccount(id, { enabled: (event.target as HTMLInputElement).checked });
}

function removeAccount(id: string) {
  void props.session.deleteAccount(id);
}

function close() {
  emit('close');
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') close();
}

watch(
  () => props.open,
  async open => {
    if (typeof window === 'undefined') return;
    if (open) {
      section.value = 'general';
      window.addEventListener('keydown', onKeydown);
      await nextTick();
      closeButton.value?.focus();
    } else {
      window.removeEventListener('keydown', onKeydown);
    }
  },
  { immediate: true }
);

onBeforeUnmount(() => {
  if (typeof window !== 'undefined') window.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="settings-overlay" @click.self="close">
      <div class="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header class="settings-head">
          <h2 id="settings-title">设置</h2>
          <button ref="closeButton" class="icon-button" aria-label="关闭设置" @click="close">✕</button>
        </header>

        <div class="settings-main">
          <nav class="settings-nav" aria-label="设置分组">
            <button class="settings-tab" :aria-current="section === 'general'" @click="section = 'general'">通用</button>
            <button class="settings-tab" :aria-current="section === 'compression'" @click="section = 'compression'">压缩</button>
            <button class="settings-tab" :aria-current="section === 'share'" @click="section = 'share'">分享</button>
            <button class="settings-tab" :aria-current="section === 'about'" @click="section = 'about'">关于</button>
          </nav>

          <div class="settings-body">
            <p v-if="session.state.error" class="notice notice--error" role="alert">{{ session.state.error }}</p>

            <section v-if="section === 'general'" class="settings-section">
              <label class="settings-row">
                <span>启动时显示</span>
                <select :value="view.general.startFace" @change="setStartFace">
                  <option value="last">上次使用的面</option>
                  <option value="compress">压缩</option>
                  <option value="share">分享</option>
                </select>
              </label>
              <label class="settings-row">
                <span>访客页语言</span>
                <select :value="view.general.visitorLang" @change="setVisitorLang">
                  <option value="auto">跟随浏览器</option>
                  <option value="zh">中文</option>
                  <option value="en">English</option>
                </select>
              </label>
              <p class="settings-hint">桌面端界面语言暂不做切换；这里只影响访客页。</p>
            </section>

            <section v-else-if="section === 'compression'" class="settings-section">
              <label class="settings-row settings-row--switch">
                <span>默认开启「上传自动压缩」</span>
                <input type="checkbox" :checked="view.compression.autoCompress" @change="setAutoCompress" />
              </label>
              <label class="settings-row">
                <span>同时处理图片数</span>
                <input class="settings-number" type="number" min="1" max="5" :value="view.compression.concurrency" @change="setConcurrency" />
              </label>
              <div class="settings-row">
                <span>保存目录</span>
                <div class="settings-path-row">
                  <span class="settings-path">{{ view.compression.saveDir || '未设置（每次询问）' }}</span>
                  <button class="button" @click="session.pickDirectory('save')">选择</button>
                  <button v-if="view.compression.saveDir" class="button button--quiet" @click="clearSaveDir">清除</button>
                </div>
              </div>
            </section>

            <section v-else-if="section === 'share'" class="settings-section">
              <label class="settings-row">
                <span>端口</span>
                <input class="settings-number" type="number" min="0" max="65535" :value="view.share.port" @change="setPort" />
              </label>
              <p class="settings-hint">0 表示自动：优先 5421，被占用时退回随机端口。</p>

              <div class="settings-row">
                <span>接收上传的目录</span>
                <div class="settings-path-row">
                  <span class="settings-path">{{ view.share.uploadDir || '~/Downloads/TinyPNG Share' }}</span>
                  <button class="button" @click="session.pickDirectory('upload')">选择</button>
                  <button v-if="view.share.uploadDir" class="button button--quiet" @click="clearUploadDir">清除</button>
                </div>
              </div>

              <div class="settings-row settings-row--stack">
                <span>访问保护</span>
                <div class="settings-choices">
                  <label><input type="radio" name="protection" :checked="view.share.protection === 'link'" @change="setProtection('link')" />链接访问</label>
                  <label><input type="radio" name="protection" :checked="view.share.protection === 'pin'" @change="setProtection('pin')" />链接 + PIN</label>
                  <label><input type="radio" name="protection" :checked="view.share.protection === 'accounts'" @change="setProtection('accounts')" />账号登录</label>
                </div>
              </div>

              <div v-if="view.share.protection === 'pin'" class="settings-block">
                <p class="settings-hint">{{ view.share.pinSet ? '已设置 PIN，修改后访客需要重新解锁。' : '还没有设置 PIN。' }}</p>
                <div class="settings-inline">
                  <input v-model="pinInput" class="settings-number" inputmode="numeric" maxlength="6" placeholder="6 位数字" />
                  <button class="button" :disabled="!/^\d{6}$/.test(pinInput)" @click="savePin">保存 PIN</button>
                  <button v-if="view.share.pinSet" class="button button--quiet" @click="clearPin">清除</button>
                </div>
              </div>

              <div v-if="view.share.protection === 'accounts'" class="settings-block">
                <ul class="settings-accounts">
                  <li v-for="account in view.share.accounts" :key="account.id" class="settings-account">
                    <div class="settings-account-head">
                      <strong>{{ account.username }}</strong>
                      <label class="settings-mini"><input type="checkbox" :checked="account.enabled" @change="toggleEnabled(account.id, $event)" />启用</label>
                      <button class="button button--quiet" @click="removeAccount(account.id)">删除</button>
                    </div>
                    <div class="settings-perms">
                      <label><input type="checkbox" :checked="account.permissions.download" @change="togglePermission(account.id, 'download', $event)" />下载</label>
                      <label><input type="checkbox" :checked="account.permissions.upload" @change="togglePermission(account.id, 'upload', $event)" />上传</label>
                      <label><input type="checkbox" :checked="account.permissions.text" @change="togglePermission(account.id, 'text', $event)" />文字</label>
                    </div>
                  </li>
                </ul>
                <p v-if="!view.share.accounts.length" class="settings-hint">还没有账号，添加后访客需要登录。</p>

                <div class="settings-account-add">
                  <input v-model="accountName" placeholder="用户名" maxlength="32" />
                  <input v-model="accountPassword" type="password" placeholder="密码（至少 4 位）" />
                  <div class="settings-perms">
                    <label><input v-model="accountPermissions.download" type="checkbox" />下载</label>
                    <label><input v-model="accountPermissions.upload" type="checkbox" />上传</label>
                    <label><input v-model="accountPermissions.text" type="checkbox" />文字</label>
                  </div>
                  <button class="button" :disabled="!accountName.trim() || accountPassword.length < 4" @click="addAccount">添加账号</button>
                </div>
              </div>

              <div v-if="view.share.protection !== 'accounts'" class="settings-block">
                <label class="settings-row settings-row--switch">
                  <span>允许访客上传文件</span>
                  <input type="checkbox" :checked="view.share.allowUpload" @change="setAllowUpload" />
                </label>
                <label class="settings-row settings-row--switch">
                  <span>允许访客发布文字</span>
                  <input type="checkbox" :checked="view.share.allowText" @change="setAllowText" />
                </label>
              </div>
              <p class="settings-hint">分享运行中修改端口或保护方式会自动重启服务，旧链接随即失效。</p>
            </section>

            <section v-else class="settings-section">
              <p><strong>TinyPNG Lite / File Share</strong> 0.1.0</p>
              <p class="settings-hint">设置保存在应用配置目录；PIN 与账号口令只保存哈希，不写入日志。</p>
              <p class="settings-hint">压缩使用匿名 TinyPNG 接口；分享服务只在同一个 Tauri 进程内运行。</p>
            </section>
          </div>
        </div>

        <footer class="settings-foot">
          <span class="settings-hint">{{ session.state.saving ? '正在保存…' : '修改后立即生效' }}</span>
          <button class="button button--primary" @click="close">完成</button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

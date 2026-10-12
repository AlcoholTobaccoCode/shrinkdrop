import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import './styles/tokens.css';
import { createPlatformAdapters, isTauriRuntime } from './platform';
import { LocalExecutor } from './core/local/local-executor';
import { configureExecutorFactory } from './stores/workbench';
import { createTokenStorage } from './core/settings/token-storage';
import { configureSettingsStorage, useSettingsStore } from './stores/settings';
import { ApiClient } from './core/cloud/api-client';
import { CloudExecutor } from './core/cloud/cloud-executor';

async function bootstrap(): Promise<void> {
  // 令牌：Tauri 系统钥匙串 / Web sessionStorage，绝不进 localStorage
  configureSettingsStorage({ token: await createTokenStorage(isTauriRuntime()) });
  const adapter = await createPlatformAdapters();
  configureExecutorFactory((mode, pipeline) => {
    if (mode === 'private-local') return new LocalExecutor({ adapter, pipeline });
    const settings = useSettingsStore();
    if (!settings.serverUrl) throw new Error('请先在设置里填写 Server 地址');
    const api = new ApiClient({ baseUrl: settings.serverUrl, getToken: () => settings.getToken() });
    return new CloudExecutor({ api, adapter, pipeline });
  });
  createApp(App).use(createPinia()).mount('#app');
}

void bootstrap();

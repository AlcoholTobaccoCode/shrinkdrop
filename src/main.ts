import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import './styles/tokens.css';
import { createPlatformAdapters, isTauriRuntime } from './platform';
import { LocalExecutor } from './core/local/local-executor';
import { configureExecutorFactory } from './stores/workbench';
import { createTokenStorage } from './core/settings/token-storage';
import { configureSettingsStorage } from './stores/settings';

async function bootstrap(): Promise<void> {
  // 令牌：Tauri 系统钥匙串 / Web sessionStorage，绝不进 localStorage
  configureSettingsStorage({ token: await createTokenStorage(isTauriRuntime()) });
  const adapter = await createPlatformAdapters();
  configureExecutorFactory((mode, pipeline) => {
    if (mode === 'private-local') return new LocalExecutor({ adapter, pipeline });
    throw new Error('云端执行器尚未实现（D4）');
  });
  createApp(App).use(createPinia()).mount('#app');
}

void bootstrap();

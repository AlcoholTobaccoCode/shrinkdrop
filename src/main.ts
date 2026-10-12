import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import './styles/tokens.css';
import { isTauriRuntime } from './platform';
import { createTokenStorage } from './core/settings/token-storage';
import { configureSettingsStorage } from './stores/settings';

async function bootstrap(): Promise<void> {
  // 令牌：Tauri 系统钥匙串 / Web sessionStorage，绝不进 localStorage
  configureSettingsStorage({ token: await createTokenStorage(isTauriRuntime()) });
  createApp(App).use(createPinia()).mount('#app');
}

void bootstrap();

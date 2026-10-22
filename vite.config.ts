import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    host: '127.0.0.1',
    port: 5170,
    strictPort: true
  },
  build: {
    target: 'es2020',
    rollupOptions: {
      input: {
        main: resolve(process.cwd(), 'index.html'),
        settings: resolve(process.cwd(), 'settings.html')
      }
    }
  }
});

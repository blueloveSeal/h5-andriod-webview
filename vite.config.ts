// 工程结构派生自 https://github.com/electron-vite/electron-vite-vue，保留其 MIT 许可。
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import electron from 'vite-plugin-electron/simple';

export default defineConfig({
  base: './',
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  plugins: [
    vue(),
    electron({
      main: {
        entry: 'electron/main.ts',
        async onstart({ startup }) { await startup(['.']); },
      },
      preload: {
        input: 'electron/preload.ts',
        vite: { build: { rolldownOptions: { output: { entryFileNames: 'preload.cjs' } } } },
      },
    }),
  ],
});

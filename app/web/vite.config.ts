import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'path';

export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:30080'
    }
  },
  build: {
    outDir: path.resolve(__dirname, '../www'),
    emptyOutDir: true
  }
});

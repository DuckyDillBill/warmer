import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        eyes: resolve(__dirname, 'eyes.html'),
        kiosk: resolve(__dirname, 'kiosk.html'),
        live: resolve(__dirname, 'live.html'),
      },
    },
  },
});

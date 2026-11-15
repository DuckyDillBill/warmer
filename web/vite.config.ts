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
        watch: resolve(__dirname, 'watch.html'),
        terminal: resolve(__dirname, 'terminal.html'),
        microwave: resolve(__dirname, 'microwave.html'),
        checkin: resolve(__dirname, 'checkin.html'),
      },
    },
  },
});

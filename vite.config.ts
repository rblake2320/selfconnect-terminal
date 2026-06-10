/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const isPreview = process.env.SELFCONNECT_PREVIEW === '1';

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  plugins: [react()],
  // Compile-time flag. ONLY the preview build (SELFCONNECT_PREVIEW=1) gets the
  // simulated mock bridge baked in; the real Electron renderer bundle is built
  // with this false, so the mock can never activate inside the app.
  define: {
    __SELFCONNECT_PREVIEW__: JSON.stringify(isPreview),
  },
  build: {
    outDir: resolve(__dirname, isPreview ? 'dist-preview' : 'dist/renderer'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, 'src/renderer/index.html'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    root: resolve(__dirname),
  },
});

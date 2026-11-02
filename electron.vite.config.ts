import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

// The sources are in app/ (the plan's layout: core/ and app/), not electron-vite's default src/, so each entry is given
export default defineConfig({
  main: {
    build: { lib: { entry: resolve('app/main/index.ts') } },
  },
  preload: {
    build: { lib: { entry: resolve('app/preload/index.ts') } },
  },
  renderer: {
    root: resolve('app/renderer'),
    build: {
      outDir: resolve('out/renderer'),
      emptyOutDir: true,
      rolldownOptions: { input: resolve('app/renderer/index.html') },
    },
    plugins: [react()],
  },
});

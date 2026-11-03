import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The sources are in app/ (the plan's layout: core/ and app/), not electron-vite's default src/, so each entry is given
export default defineConfig({
  // The main process. The core's process it starts (app/core-host, a utilityProcess) is built on its own from its
  // ?modulePath import: as a second entry, the code both use went into the core's bundle, which the main process then
  // loaded, running the core inside it
  main: {
    build: { rolldownOptions: { input: resolve('app/main/index.ts') } },
  },
  preload: {
    build: { lib: { entry: resolve('app/preload/index.ts') } },
  },
  renderer: {
    root: resolve('app/renderer'),
    // @ is app/renderer/src, as in tsconfig.web.json and the aliases of components.json (shadcn/ui)
    resolve: { alias: { '@': resolve('app/renderer/src') } },
    build: {
      outDir: resolve('out/renderer'),
      emptyOutDir: true,
      rolldownOptions: { input: resolve('app/renderer/index.html') },
    },
    plugins: [react(), tailwindcss()],
  },
});

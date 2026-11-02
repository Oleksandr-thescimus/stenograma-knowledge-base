import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Vite's dev server adds CSS as <style> tags, while the build links a CSS file. So only the dev server allows inline
// styles in the CSP of index.html
const allowInlineStylesInDev = (): Plugin => ({
  name: 'allow-inline-styles-in-dev',
  apply: 'serve',
  transformIndexHtml: (html) => html.replace('style-src \'self\'', 'style-src \'self\' \'unsafe-inline\''),
});

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
    // @ is app/renderer/src, as in tsconfig.web.json and the aliases of components.json (shadcn/ui)
    resolve: { alias: { '@': resolve('app/renderer/src') } },
    build: {
      outDir: resolve('out/renderer'),
      emptyOutDir: true,
      rolldownOptions: { input: resolve('app/renderer/index.html') },
    },
    plugins: [react(), tailwindcss(), allowInlineStylesInDev()],
  },
});

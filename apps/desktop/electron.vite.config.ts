import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../..');

/** Node-side packages that must stay external (loaded from the root node_modules at runtime). */
const nodeExternals = [
  /^@scrappia\//,
  'patchright', 'playwright', 'jsdom', 'exceljs', 'zod', 'croner', 'papaparse', '@mozilla/readability', 'turndown',
  '@anthropic-ai/sdk', 'robots-parser', 'proxy-chain', 'microdiff', 'undici', 'nanoid', 'pg', 'mysql2', 'mongodb', 'hyparquet-writer',
];

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
    build: {
      outDir: 'out/main',
      rollupOptions: { external: nodeExternals },
    },
  },
  preload: {
    resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
    build: { outDir: 'out/preload' },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        // type-only imports; keep vite from resolving into core's node code if something slips through
        '@scrappia/core': resolve(root, 'packages/core/src/index.ts'),
      },
    },
    plugins: [react()],
    build: {
      outDir: 'out/renderer',
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') },
    },
  },
});

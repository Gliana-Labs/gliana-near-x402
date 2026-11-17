import { defineConfig } from 'vite';

// GitHub Pages serves ../docs from a sub-path, so every asset path is relative.
// optimizeDeps is the dev server's dependency pre-bundle only: @near-js reads process.env.DEFAULT_FINALITY at load, and
// without this `npm run dev` showed "Read-only: wallets could not load" (the production build was never affected).
export default defineConfig({
  base: './',
  build: { outDir: '../docs', emptyOutDir: true, target: 'es2022', chunkSizeWarningLimit: 3000 },
  optimizeDeps: { esbuildOptions: { define: { 'process.env': '{}', global: 'globalThis' } } },
});

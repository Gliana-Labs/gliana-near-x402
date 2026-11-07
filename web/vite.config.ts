import { defineConfig } from 'vite';

// GitHub Pages serves ../docs from a sub-path, so every asset path is relative.
export default defineConfig({ base: './', build: { outDir: '../docs', emptyOutDir: true, target: 'es2022', chunkSizeWarningLimit: 3000 } });

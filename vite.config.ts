import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const backend = `http://127.0.0.1:${process.env.PELICAN_PORT ?? '7860'}`;

export default defineConfig({
  root: 'src/web',
  // Every URL is relative: the app works at `/` and under any path prefix a
  // reverse proxy mounts it at, without being told which.
  base: './',
  publicDir: '../../public',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: backend, ws: true },
    },
  },
});

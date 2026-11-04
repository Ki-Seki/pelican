import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const backend = `http://127.0.0.1:${process.env.PELICAN_PORT ?? '7860'}`;

export default defineConfig({
  root: 'src/web',
  // Every URL is relative: the app is served under a path prefix it does not
  // know (`/_m/<machine>/pelican/` behind AI Server), or at `/` when run alone.
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

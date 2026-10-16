import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = process.env.ZF_API ?? 'http://localhost:8787';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': { target: api, changeOrigin: false }, '/mcp': api } },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 6000 },
  worker: { format: 'es' },
});

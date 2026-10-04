import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  // Recharts + React dão ~170 kB gzip num único arquivo; aceitável para uma página só
  build: { outDir: '../dist/web', emptyOutDir: true, chunkSizeWarningLimit: 700 },
  // Em dev (npm run dev:web) a API continua no backend: npm run dev:api
  server: { proxy: { '/api': `http://localhost:${process.env.PORT ?? 3000}` } },
});

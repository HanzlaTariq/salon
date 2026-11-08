import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// In dev the browser talks to Vite, which proxies /api to the backend (no CORS needed locally).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, proxy: { '/api': 'http://localhost:3000' } },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});

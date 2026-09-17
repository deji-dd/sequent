import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { createLogger, defineConfig } from 'vite';

// Filter out harmless ECONNRESET errors triggered when the browser abruptly disconnects on reload
const logger = createLogger();
const originalError = logger.error;
logger.error = (msg, options) => {
  if (
    options?.error?.message?.includes('ECONNRESET') ||
    (options?.error as any)?.code === 'ECONNRESET' ||
    msg.includes('ECONNRESET')
  ) {
    return;
  }
  originalError(msg, options);
};

export default defineConfig({
  root: 'ui',
  customLogger: logger,
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './ui/src'),
      '@core': path.resolve(import.meta.dirname, './src/core'),
    },
  },
  plugins: [react(), tailwindcss()],
  server: {
    port: 5174,
    proxy: {
      '/api': {
        target: 'http://localhost:3003',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:3003',
        ws: true,
      },
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
});

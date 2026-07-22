import path from 'path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const configDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  return {
    server: {
      proxy: {
        '/api': {
          target: 'http://localhost:3501',
          changeOrigin: true
        },
        '/library': {
          target: 'http://localhost:3501',
          changeOrigin: true
        }
      }
    },
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(configDir, '.'),
      }
    }
  };
});

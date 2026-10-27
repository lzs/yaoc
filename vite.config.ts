import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import pkg from './package.json';
import { fileURLToPath } from 'node:url';
import { createBuildInfo, syncVersion } from './scripts/sync-version.cjs';

export default defineConfig(({ mode }) => {
  const build = createBuildInfo(pkg.version, mode === 'release');

  return {
    plugins: [
      react(),
      {
        name: 'yaoc-sync-build-version',
        apply: 'build',
        writeBundle() {
          syncVersion(fileURLToPath(new URL('.', import.meta.url)), build.version);
        },
      },
    ],
    base: './',
    define: {
      __APP_VERSION_LABEL__: JSON.stringify(build.version),
      __APP_BUILD_TIMESTAMP__: JSON.stringify(build.timestamp),
      __APP_CHANNEL__: JSON.stringify(build.channel),
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
    },
    server: {
      port: 5173,
      strictPort: true,
    },
  };
});

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import pkg from './package.json';

function formatBuildTimes(date: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  const yyyy = date.getFullYear();
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const min = pad(date.getMinutes());
  return {
    compactStamp: `${mm}.${dd}-${hh}${min}`,
    readableTimestamp: `${yyyy}-${mm}-${dd} ${hh}:${min}`,
  };
}

export default defineConfig(({ mode }) => {
  const { compactStamp, readableTimestamp } = formatBuildTimes(new Date());
  const isOfficialRelease = mode === 'release';
  const baseVersion = pkg.version || '2026.1';
  const hasExplicitSuffix = baseVersion.includes('-');
  const channel: 'official' | 'beta' =
    isOfficialRelease && !hasExplicitSuffix ? 'official' : 'beta';
  const versionWithChannel =
    hasExplicitSuffix || isOfficialRelease ? baseVersion : `${baseVersion}-beta`;
  const versionLabel = `v${versionWithChannel} (${compactStamp})`;

  return {
    plugins: [react()],
    base: './',
    define: {
      __APP_VERSION_LABEL__: JSON.stringify(versionLabel),
      __APP_BUILD_TIMESTAMP__: JSON.stringify(readableTimestamp),
      __APP_CHANNEL__: JSON.stringify(channel),
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

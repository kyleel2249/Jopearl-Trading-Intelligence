import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Base path is chosen explicitly, never inferred from the CI environment.
// GitHub Actions sets GITHUB_ACTIONS=true for EVERY workflow, including the
// Android (Capacitor) and Electron builds, which are served from the origin
// root. Inferring the base from that variable produced /JPTI/ asset URLs in
// native and desktop bundles and left them blank. Only the GitHub Pages
// workflow sets JPTI_BASE_PATH=/JPTI/.
function resolveBase(value) {
  const raw = String(value || '/').trim();
  if (raw === '' || raw === '/') return '/';
  if (!/^\/[A-Za-z0-9._~\-\/]*$/.test(raw)) {
    throw new Error('JPTI_BASE_PATH must be an absolute path such as /JPTI/, received: ' + raw);
  }
  return raw.endsWith('/') ? raw : raw + '/';
}

export default defineConfig({
  base: resolveBase(process.env.JPTI_BASE_PATH),
  plugins: [react()],
  build: {
    // Keep third-party code in stable, cacheable vendor chunks so the app entry stays small.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'vendor-react';
          if (id.includes('lucide-react')) return 'vendor-icons';
          return undefined;
        }
      }
    }
  },
  server: {
    host: '0.0.0.0',
    proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true } }
  }
});

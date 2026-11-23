# Client runtime configuration

- `src/lib/config.js` reads public Vite configuration.
- `src/lib/api.js` resolves the same-origin Cloudflare Pages Functions API.
- `src/lib/cloudflare-analytics.js` exposes safe no-op native analytics hooks; configure Cloudflare Web Analytics in the Pages project dashboard.

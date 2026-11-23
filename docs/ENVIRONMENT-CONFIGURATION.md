# JPTI Environment Configuration

JPTI's production web hosting and public market-data API run on Cloudflare Pages.

## Frontend build variables
The root `.env.example` lists browser-safe Vite settings. Vite values are bundled into the app and must never contain credentials.

- `VITE_APP_NAME`: application name.
- `VITE_APP_ENV`: environment label.
- `VITE_API_BASE_URL`: blank for Cloudflare web builds; set to the public Pages origin for native Android builds.
- `VITE_WS_URL`: optional secure WebSocket endpoint; leave blank unless a Cloudflare-hosted socket service is configured.
- `VITE_ENABLE_ANALYTICS`, `VITE_ENABLE_CRASH_REPORTING`, `VITE_ENABLE_PERFORMANCE_MONITORING`, `VITE_ENABLE_CONFIG_DIAGNOSTICS`: feature switches.

## Cloudflare configuration
Use GitHub Actions secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` for Pages deployment. Set `CLOUDFLARE_PAGES_URL` as a repository variable for Android builds. `.dev.vars` is for local Pages Functions development and must not be committed.

## Secrets
Private exchange credentials, signing secrets and Cloudflare deployment tokens must remain in server-side secret stores. Never place them in `VITE_*` variables or APK bundles.

JPTI no longer uses Render, GitHub Pages or Firebase hosting/distribution. Android builds are published as GitHub Actions artifacts; Cloudflare Pages remains the only web host.

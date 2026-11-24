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

## Node API and desktop server variables
The Node API (`api/server.js`, also used by the desktop app) reads many `JPTI_*` variables that do not apply to the Cloudflare Pages edge. Every one of them is described in `api/config-registry.js` with its default, allowed range, whether a restart is needed and whether it is sensitive. That registry also drives the in-app configuration manager and the configuration audit, and `api/config-registry.test.js` fails if the API reads a `JPTI_*` variable that is not registered, so this list cannot silently drift. Legacy Node API variables do not activate Node-only backend services inside Cloudflare Pages.

## Validation and checks
- `npm run env:check` runs `scripts/check-env.mjs`. It inspects frontend environment files for secret-like Vite variable names, validates API and WebSocket URL formats, and warns when the API origin is blank. It never prints environment values.
- `npm run check` applies the T-Bots adapter overlays, then runs `scripts/check-syntax.mjs`, which discovers and syntax-checks every `.js`, `.mjs` and `.cjs` file in the repository (`npm run check:syntax` runs the discovery step alone). New files are covered automatically.
- `npm test` runs the full regression suite.

## Workflows
- `cloudflare-pages.yml` deploys the web app and Pages Functions to Cloudflare Pages.
- `ci.yml` validates every push and pull request with read-only repository access.
- The Android and desktop workflows build installers and APK artifacts for testing; they do not host the web application.

## Client runtime configuration
- `src/lib/config.js` reads public Vite configuration.
- `src/lib/api.js` resolves the same-origin Cloudflare Pages Functions API.
- `src/lib/cloudflare-analytics.js` exposes safe no-op native analytics hooks; configure Cloudflare Web Analytics in the Pages project dashboard.

## Secrets
Private exchange credentials, signing secrets and Cloudflare deployment tokens must remain in server-side secret stores. Never place them in `VITE_*` variables or APK bundles.

JPTI no longer uses Render, GitHub Pages or Firebase hosting/distribution. Android builds are published as GitHub Actions artifacts; Cloudflare Pages remains the only web host.

# JPTI Cloudflare Migration — Audit Report

## Executive result

The repository was audited from the supplied `JPTI-main.zip` archive. The production web-hosting configuration has been moved to Cloudflare Pages, and the public market-data API no longer forwards requests to Render or requires a separately configured API gateway URL.

This is a **Cloudflare hosting and public-chart migration**, not a completed port of every legacy Node API service. The existing Express/CCXT modules still exist for local development and desktop use; their filesystem, PostgreSQL, scheduler and private-account functions are not automatically executable in Cloudflare Pages Functions.

## Changes applied

### Hosting and deployment
- Added root `wrangler.toml` for the `jpti` Cloudflare Pages project.
- Added `.github/workflows/cloudflare-pages.yml` to build, verify and deploy the web application to Cloudflare Pages.
- Removed Render deployment files and references: `render.yaml`, `Dockerfile`, `Procfile`, Render API deployment documentation and the Render keep-alive workflow.
- Removed the GitHub Pages deployment workflow.
- Removed the unused `.dockerignore`.
- Kept Android and desktop artifact workflows; these build application packages and are not alternative web hosts.

### Cloudflare-native API and market charts
- Replaced the Pages Function Render pass-through with a Cloudflare-native, read-only edge API.
- Added same-origin routes for health, exchange catalog, market catalog, ticker, OHLCV candlesticks and cross-venue public ticker comparison.
- Supported public spot data from Binance, Bybit, OKX and Bitget.
- Added a bounded single-timeframe OHLCV context score for the chart. It reports its limitations and does not fabricate order-book, funding or global-market evidence.
- Added an explicit `x-jpti-runtime: cloudflare-edge` response marker so the client selects the supported spot-data mode.
- Added Capacitor WebView CORS support for standard local origins.
- Added explicit unsupported responses for private, execution and other legacy API routes. They are never silently forwarded to a different host.
- Updated the chart to pass its selected market type to API requests. The Cloudflare adapter refuses to label spot candles as futures.

### Endpoint and environment cleanup
- Removed the manual external API gateway and token requirement from Connection Settings.
- Old saved API URLs and tokens are cleared/ignored so stale Render endpoints cannot override the Cloudflare Pages origin.
- Replaced root `.env.example` with browser-safe Vite configuration.
- Added `.dev.vars.example` for local Pages Functions development.
- Added Cloudflare deployment instructions and native Android Pages-origin configuration.
- Kept private values out of `VITE_*` variables.

### Other external-service cleanup
- Removed Firebase Android Gradle plugins, Firebase SDK dependencies, Google Services configuration files and Firebase App Distribution steps.
- Replaced the native analytics bridge with a safe no-op adapter; Cloudflare Web Analytics can be enabled from the Pages dashboard.
- Replaced the integrated T-Bots Firebase run-history adapter with bounded local device storage.
- Preserved the T-Bots integration and its Cloudflare Worker deployment files.

## Cloudflare setup required

GitHub repository secrets:
- `CLOUDFLARE_API_TOKEN` — Pages deployment permission.
- `CLOUDFLARE_ACCOUNT_ID` — Cloudflare account ID.

Optional GitHub repository variable:
- `CLOUDFLARE_PAGES_URL` — public Pages origin used by Android builds, for example `https://jpti.pages.dev`.

Cloudflare Pages project:
- Project name: `jpti`
- Build command: `npm run build:pages`
- Output directory: `dist`
- Root directory: `/`

The Pages web build leaves `VITE_API_BASE_URL` blank. Android builds use the public Cloudflare Pages origin because a Capacitor WebView cannot call its own asset origin as the API.

## Verification performed

- `npm run check`: passed.
- `npm run env:check`: passed.
- Focused automated tests covering API resolution, stale gateway cleanup, direct market parsing, Cloudflare edge routing, chart context, CORS, environment registry, frontend entry and T-Bots local history: passed.
- 60 focused tests passed in the final targeted run.
- Node syntax check: 200 JavaScript files passed.
- TypeScript transpilation/syntax validation: 30 JSX/TS files passed.

## Verification not completed

The archive did not include `node_modules` or a lockfile. `npm install --ignore-scripts --no-audit --no-fund` timed out in this execution environment, so the complete dependency-backed test suite and Vite production build could not be run here. Live exchange requests and a real Cloudflare deployment could not be tested from this environment.

The existing `android/app/downloads/JPTI-Android-debug.apk` is a previously built artifact and was not regenerated because the Android dependency install/build could not be completed. Rebuild it through the Android workflow before distribution.

## Remaining Cloudflare port work — not to be marked complete

The current Pages edge runtime does not yet implement:
- Futures/perpetual, margin, CFD and options market feeds.
- Private exchange balances, authenticated account data or order execution.
- Durable portfolio ledger, user/session persistence and encrypted server-side credential vault.
- Background scheduler, market monitor, fill reconciliation and queue-driven jobs.
- Server-backed Alpha, institutional, portfolio, futures, risk, replay and other advanced API endpoints.
- Production WebSocket relay or server-side order-book/funding streams.

Those features still exist in the legacy Node code and/or client-side analysis. To run them entirely on Cloudflare, they need explicit Cloudflare-native implementations using appropriate Workers, D1, Durable Objects, Queues, KV and secret bindings, followed by endpoint-level regression and live deployment tests.

Cloudflare hosting cannot guarantee permanent uptime, and public exchange endpoints can rate-limit or fail independently. The app now removes the separate gateway dependency for supported public spot charts, but should not report unsupported services as operational.

## D1/KV configuration update

The supplied Cloudflare resource IDs have now been added to the root `wrangler.toml` using the server-side aliases `JPTI_DB` and `JPTI_KV`. A separate SQLite-compatible migration directory (`migrations/d1/`) has been added so Wrangler does not attempt to apply the legacy PostgreSQL/Supabase SQL files. The new D1 schema covers durable events, deduplication, sync cursors, scheduler lease metadata and a transactional outbox.

A read-only Pages Function diagnostic is available at `/api/storage/health`. It checks that both bindings are present, queries the D1 schema, and performs a KV read. It reports `migration-required` until all expected tables exist. Focused tests cover missing bindings, successful D1/KV checks and missing migrations.

This update configures the Cloudflare resources and creates the D1 schema foundation; it does not yet migrate every legacy Express service, private exchange operation, trading ledger consumer or background scheduler to Pages Functions. Those services remain explicitly out of scope until separately ported and verified.

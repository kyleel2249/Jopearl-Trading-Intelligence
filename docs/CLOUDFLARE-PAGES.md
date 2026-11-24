# JPTI — Cloudflare-only deployment

JPTI's supported web host is **Cloudflare Pages**. The frontend and its same-origin `/api/*` market-data functions deploy together. The Pages Function normally calls public exchange REST endpoints from Cloudflare's edge. If an exchange rejects a particular edge region, the frontend's tested browser-direct fallback requests public data from the user's browser. Neither path requires a separately hosted API gateway URL or token.

## Cloudflare Pages project

| Setting | Value |
| --- | --- |
| Project name | `jpti` |
| Framework preset | None |
| Root directory | `/` |
| Build command | `npm run build:pages` |
| Build output directory | `dist` |
| Node version | `22` |

The root `wrangler.toml` contains the Pages output directory and Workers compatibility settings. Wrangler CLI `4.167.0` is pinned in `package.json`; the `.github/workflows/cloudflare-pages.yml` workflow uses that local CLI for D1 migrations and Pages deployment on pushes to `main`. GitHub Actions checkout and Node setup use current Node 24-compatible action releases.

## GitHub Actions secrets

Configure these repository secrets:

- `CLOUDFLARE_API_TOKEN` — Cloudflare API token with **Cloudflare Pages: Edit** and **D1: Edit** permissions for the target account. The workflow validates that the secret is present, applies pending D1 migrations, then deploys Pages.
- `CLOUDFLARE_ACCOUNT_ID` — Cloudflare account ID.

Add these under the repository's **Settings → Secrets and variables → Actions → Repository secrets**. The workflow currently reads repository-level secrets; secrets stored only in a GitHub Environment are not visible unless that environment is explicitly attached to the job.

Optional repository variable for native Android builds:

- `CLOUDFLARE_PAGES_URL` — public Pages origin, e.g. `https://jpti.pages.dev`. It is a public URL, not a secret.

## Environment files

- `.env` — public Vite build settings only. `VITE_API_BASE_URL` stays blank for the Cloudflare web build because the API is same-origin.
- `.dev.vars` — local Cloudflare Pages Functions runtime variables. Copy `.dev.vars.example` to `.dev.vars` when needed.
- Cloudflare dashboard Variables and Secrets — server-side values only. Never put private exchange credentials, signing secrets, or tokens in `VITE_*` variables.

The current Cloudflare edge API provides public spot market catalogs, tickers and OHLCV candlesticks for Binance, Bybit, OKX and Bitget. Bitget additionally exposes public Margin, USDT-M, Coin-M and USDC-M instrument catalogs, tickers and candles. Exact Bitget instrument IDs are carried through chart, ticker, candle and context requests, including contract IDs that differ from a reconstructed base/quote symbol. Cross-venue ticker comparison and a limited single-timeframe OHLCV context score are also available. These public feeds require no exchange API keys and no separate API gateway. The live post-deploy workflow checks all five Bitget categories; if Bitget returns HTTP 403 from the runner's region, it reports a regional warning and verifies direct public endpoints where that region permits.

## Runtime capability boundary

The existing Express/CCXT API contains Node-specific services, local filesystem storage and PostgreSQL integration. Those services are **not automatically executable inside Pages Functions**. The edge function explicitly reports unsupported endpoints rather than silently forwarding them to another host. Private account access, live order execution, durable portfolio ledger, scheduler jobs and server-backed advanced analytics still need Cloudflare-native implementations (Workers/D1/Queues/Durable Objects as appropriate) and must not be marked operational until tested.

Public chart indicators and chart-side intelligence continue to run in the frontend using the received OHLCV candles. Exchange outages, rate limits, Cloudflare incidents and network failures can still interrupt live data; no hosting provider can promise uninterrupted availability.

## Local verification

```bash
npm install
npm run check
npm test
npm run build:pages
npm run dev:pages
```

The Pages Functions API is available under `/api/*` when running `wrangler pages dev`.

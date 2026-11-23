# JPTI — Cloudflare-only deployment

JPTI's supported web host is **Cloudflare Pages**. The frontend and its same-origin `/api/*` market-data functions deploy together. The Pages Function calls public exchange REST endpoints from Cloudflare's edge; the browser does not need a separately hosted API gateway URL or token.

## Cloudflare Pages project

| Setting | Value |
| --- | --- |
| Project name | `jpti` |
| Framework preset | None |
| Root directory | `/` |
| Build command | `npm run build:pages` |
| Build output directory | `dist` |
| Node version | `22` |

The root `wrangler.toml` contains the Pages output directory and Workers compatibility settings. The `.github/workflows/cloudflare-pages.yml` workflow deploys on pushes to `main`.

## GitHub Actions secrets

Configure these repository secrets:

- `CLOUDFLARE_API_TOKEN` — Cloudflare API token with Pages edit/deploy permissions for the account.
- `CLOUDFLARE_ACCOUNT_ID` — Cloudflare account ID.

Optional repository variable for native Android builds:

- `CLOUDFLARE_PAGES_URL` — public Pages origin, e.g. `https://jpti.pages.dev`. It is a public URL, not a secret.

## Environment files

- `.env` — public Vite build settings only. `VITE_API_BASE_URL` stays blank for the Cloudflare web build because the API is same-origin.
- `.dev.vars` — local Cloudflare Pages Functions runtime variables. Copy `.dev.vars.example` to `.dev.vars` when needed.
- Cloudflare dashboard Variables and Secrets — server-side values only. Never put private exchange credentials, signing secrets, or tokens in `VITE_*` variables.

The current Cloudflare edge API provides public spot exchange catalog, ticker, OHLCV candlesticks, cross-venue ticker comparison and a limited single-timeframe OHLCV context score for Binance, Bybit, OKX and Bitget. It requires no exchange API keys and no remote gateway.

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

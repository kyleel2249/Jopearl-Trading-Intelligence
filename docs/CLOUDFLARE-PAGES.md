# JPTI — Cloudflare-only deployment

JPTI's supported web host is **Cloudflare Pages**. The frontend and its same-origin `/api/*` market-data functions deploy together. The Pages Function normally calls public exchange REST endpoints from Cloudflare's edge. If an exchange rejects requests originating from the Pages Worker, the frontend's tested browser-direct fallback requests public data from the user's browser. Neither path requires a separately hosted API gateway URL or token.

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
- `.dev.vars` — local Cloudflare Pages Functions runtime variables. Copy `.dev.vars.example` to `.dev.vars` and set a private `JPTI_JOURNAL_TOKEN` for local journal/session/learning sync.
- Cloudflare dashboard Variables and Secrets — set `JPTI_JOURNAL_TOKEN` as an encrypted secret for Production and Preview. Never put private exchange credentials, signing secrets, or tokens in `VITE_*` variables.

The current Cloudflare edge API provides public spot market catalogs, tickers and OHLCV candlesticks for Binance, Bybit, OKX and Bitget. Bitget additionally exposes public Margin, USDT-M, Coin-M and USDC-M instrument catalogs, tickers and candles. Bitget CFD instruments, bid/ask midpoint tickers and side-specific historical candles are routed through a separate signed Cloudflare Pages Function using an account-scoped UTA read-only API key. Exact Bitget instrument IDs are carried through chart, ticker, candle and context requests, including contract IDs that differ from a reconstructed base/quote symbol. Cross-venue ticker comparison and a limited single-timeframe OHLCV context score are also available. Spot, Margin and crypto Futures feeds require no exchange API keys or separate API gateway. CFD market data requires the three Cloudflare secrets `JPTI_BITGET_API_KEY`, `JPTI_BITGET_API_SECRET` and `JPTI_BITGET_API_PASSPHRASE`; configure a Bitget UTA API key with Read-only permission only. Never put these values in Vite variables or browser code. CFD candle history is side-specific (`buy` or `sell`) and Bitget does not return traded volume in that candle endpoint. The live post-deploy workflow checks all five Bitget categories; if Bitget returns HTTP 403 to the Pages Worker egress, it reports an edge warning and verifies the same public endpoints directly from the GitHub runner.

## Private journal, outcome memory and adaptive learning

The Cloudflare Pages Functions expose these same-origin, private-token-protected routes. They use the existing D1 database and do not need another host or an external API gateway:

| Route | Methods | Storage / purpose |
| --- | --- | --- |
| `/api/journal/entries` | GET, POST | Reflective journal entries in `jpti_journal_entries` |
| `/api/session/memory` | GET, POST | Session trade outcomes and grouped performance summaries in `jpti_events` |
| `/api/session/memory/batch` | POST | Idempotent import of session outcomes |
| `/api/alpha/gainz/outcomes` | GET, POST | GainzAlpha supervised outcome history in `jpti_events` |
| `/api/mentor/analyze` | POST | Optional Workers AI mentor review and public pair research |
| `/api/auth/check` | GET | Token check used by Connection Settings. Needs no D1 binding and never echoes a token |

Set the encrypted Cloudflare Pages secret `JPTI_JOURNAL_TOKEN`. In the app, connect the private journal with the same token. The token stays in browser session storage and is sent only to the private JPTI routes. The session and GainzAlpha outcome endpoints use the same authorization check. D1 writes are idempotent, payloads are bounded, and the existing `jpti_events_kind_time` index supports recent-history reads.

All private routes (journal, session memory, GainzAlpha outcomes, agents, council, departments, paper fleet and intelligence foundation) share one authorization check in `functions/private-auth.js`. It trims whitespace from both the stored secret and the supplied token, accepts the token in `x-jpti-api-token` or as `Authorization: Bearer`, falls back to `JPTI_API_TOKEN` when `JPTI_JOURNAL_TOKEN` is blank, and compares SHA-256 digests in constant time. With no secret configured, private routes fail closed with HTTP 503.

### Troubleshooting "Department API authorisation failed"

That message means the server has a secret and the browser sent a different value, or none. In Connection Settings, paste the value of the `JPTI_JOURNAL_TOKEN` secret into **Private JPTI access token** and choose **Verify access token**. The result is one of:

| Result | Meaning | Fix |
| --- | --- | --- |
| Token accepted | The server accepted the token for this browser session | Refresh the panel |
| Server rejected this token | A secret exists but the value differs | Re-copy the secret exactly, with no quotes. The token is held in session storage, so re-enter it after closing the browser |
| No secret configured (HTTP 409) | The deployment has no `JPTI_JOURNAL_TOKEN` or `JPTI_API_TOKEN` | Add it as an encrypted Pages secret for Production and Preview, then redeploy |

The check reports a missing secret as 409 instead of 5xx so it is not mistaken for an API outage.

The root `wrangler.toml` declares the Workers AI binding as `[ai] binding = "AI"`. Confirm the `AI` binding is present in the Pages Production and Preview environments, then redeploy after changing bindings. Workers AI does not require a third-party model API key; model usage is metered by Cloudflare. Local Pages development also requires an active Cloudflare account for Workers AI inference. The deterministic journal and trading engines continue to work when the optional AI binding is unavailable.

## Runtime capability boundary

The existing Express/CCXT API contains Node-specific services, local filesystem storage and PostgreSQL integration. Those services are **not automatically executable inside Pages Functions** and remain isolated to local/desktop workflows. The Cloudflare edge explicitly reports unsupported legacy routes rather than forwarding them to another host. Private exchange-account access, live order execution, a complete portfolio ledger, scheduled engines and other legacy server-backed analytics still need Cloudflare-native implementations (Workers/D1/Queues/Durable Objects as appropriate) and must not be marked operational until deployed tests pass.

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


### Bitget CFD Cloudflare secrets

In Cloudflare Dashboard → Workers & Pages → the `jpti` Pages project → Settings → Variables and Secrets, add these as **encrypted secrets** for Production (and Preview if you use preview deployments):

- `JPTI_BITGET_API_KEY`
- `JPTI_BITGET_API_SECRET`
- `JPTI_BITGET_API_PASSPHRASE`

Create the Bitget key with permission type **Read-only** and include **UTA trade read-only** (`uta_trade`) access. Do not grant read/write trade, Transfer or Withdraw permissions for chart access. Keep the key IP restriction aligned with the egress/IP policy you choose; Cloudflare Pages egress IPs are not a fixed single IP range, so do not bind the key to a guessed IP address. The CFD market-data endpoints require authenticated UTA access; the browser never receives the key or secret.

The CFD product selector is available for Bitget only. Supported CFD chart intervals are 1m, 15m, 1h, 4h and 1d. Buy/Ask and Sell/Bid candles are separate series; the adapter reports zero volume availability rather than inventing CFD volume. CFD ticker `last` is explicitly marked as the bid/ask midpoint because the documented endpoint returns bid and ask rather than a last-trade field.


The deployed diagnostic endpoint `/api/exchanges/bitget/cfd/diagnostics` performs a signed, read-only account-info check and returns only the permission type, permission names, whether UTA trade read-only is present, and whether an IP whitelist is configured. It never returns the API key, secret, passphrase, user ID or actual IP addresses. Use it to distinguish a missing UTA permission from a Cloudflare egress/IP-allowlist restriction. Bitget's CFD instruments endpoint also requires the account's CFD access to be enabled; complete the CFD account opening process in Bitget if that account feature has not been activated.

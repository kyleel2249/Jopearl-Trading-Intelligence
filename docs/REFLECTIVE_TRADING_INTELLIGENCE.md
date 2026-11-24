# JPTI Reflective Trading Intelligence

## Cloudflare D1 journal persistence

The reflective journal keeps a local browser copy and can synchronize entries to the existing JPTI Cloudflare D1 database. The journal API is private and refuses requests unless a Cloudflare secret is configured.

1. In Cloudflare Pages, open the `jopearl-trading-intelligence` project settings.
2. Add a secret named `JPTI_JOURNAL_TOKEN` with a long, random value. Do not put the value in source code, Vite variables, or the repository.
3. Deploy the branch after the migration is reviewed and merged.
4. Apply the D1 migration to the production database:
   `npx wrangler d1 migrations apply JPTI_DB --remote --config ./wrangler.toml`
5. Open JPTI → Reflective Trade Journal. Enter the same token in the private Cloudflare D1 journal sync section and connect.
6. The token is kept in session storage for the current browser session. Journal entries remain in D1 after the session ends. Export JSON backups periodically.

The D1 table is `jpti_journal_entries`, created by migration `0005_reflective_journal_entries.sql`. The API supports authenticated GET and POST/upsert only; it does not expose public writes, arbitrary SQL, or unauthenticated journal reads.

## Trading Development Engine

The first deterministic engine version evaluates closed OHLCV candles across 15m, 1h, 4h and 1d, using EMA20/EMA50, RSI(14), ATR(14), relative volume, confirmed pivot structure and a transparent weighted score. It separately reviews position notional, implied margin, reported liquidation distance, missing invalidation and missing exit plans.

The output is decision support, not a calibrated win probability, generative AI opinion, autonomous research service or exchange instruction. The engine does not infer news, token unlocks, institutional intent, order-book spoofing, funding or liquidation from candles. Those inputs must be supplied by verified sources or explicitly marked unavailable.

## Current adapter scope

The journal's in-app multi-timeframe futures fetch currently exposes the Bitget USDT-M futures adapter. Do not select it unless Bitget is the actual execution venue. Other venues require their own tested derivative adapters before the engine can label their futures candles as live.

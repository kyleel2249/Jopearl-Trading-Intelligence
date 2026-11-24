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

## Cloudflare Workers AI mentor and pair research

The journal can call a Cloudflare Workers AI model through a Pages Functions binding. No third-party LLM API key or external API gateway is embedded in JPTI.

1. In Cloudflare Dashboard, open Workers & Pages → JPTI Pages project → Settings → Functions → Bindings (the exact tab label may vary).
2. Add a Workers AI binding with variable name `AI`.
3. Redeploy the Pages project.
4. Keep the private `JPTI_JOURNAL_TOKEN` secret configured as described above.
5. In JPTI, connect the private D1 journal, open Coach Assessment, then select **Run full AI mentor review**.

The model currently used is Cloudflare-hosted `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. Workers AI usage is metered and may incur Cloudflare charges; check current pricing and account limits before frequent use. The model is optional: the deterministic engine and journal still work if the AI binding is absent.

The AI route performs public pair research using CoinGecko's public asset search/profile endpoints and Google News RSS. It records retrieval sources and timestamps, checks exact ticker matches and flags ambiguous matches. Public providers may rate-limit requests, return incomplete results or change their interfaces. News headlines are treated as research leads, not confirmed events. The route does not provide private exchange account data, a full derivatives order book, institutional identities or guaranteed exhaustive news coverage.

The model's role prompt covers market research, technical analysis, derivatives risk, coaching, mentorship, behavioural review, reflective writing and copywriting. It receives the user's trade record, the deterministic multi-timeframe assessment, stored research notes and recent journal history. Its output is stored in the journal record when the D1 connection is active. It cannot place or manage orders.

Cloudflare references:
- Pages Functions Workers AI binding: https://developers.cloudflare.com/pages/functions/bindings/
- Workers AI model catalogue: https://developers.cloudflare.com/workers-ai/models/
- Llama 3.3 70B model details and pricing: https://developers.cloudflare.com/workers-ai/models/llama-3.3-70b-instruct-fp8-fast/

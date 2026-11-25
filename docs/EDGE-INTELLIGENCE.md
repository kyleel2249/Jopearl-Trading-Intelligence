# Edge intelligence: calibration, alerts, scheduler and walk-forward

All four parts read the Gainz Alpha outcome ledger (`gainz-alpha-outcome` rows in D1 table `jpti_events`).

## Calibration and edge decay — `GET /api/alpha/gainz/calibration`
Token protected (`x-jpti-api-token` or `Authorization: Bearer`). Optional `symbol` and `timeframe` filters.
Returns the reliability curve (Wilson intervals), Brier score and skill, expected calibration error, and an edge
status per strategy, session and market: `healthy`, `watch` or `decaying`. Decay uses a CUSUM against a frozen
reference window and also requires recent expectancy ≤ 0, so a healthy strategy is rarely paged
(replay-measured: 2.4% false alerts on healthy histories, ~93% detection of a 55%→25% win-rate collapse).
Source: `src/gainz-alpha/calibration.js`; replay regression tests in `tests/calibration-replay.test.js`.

## Alerts — `GET /api/alerts`
Newest first; filters `severity`, `rule`, `limit`. Rules: edge-decay, edge-recovered, loss-streak,
daily-loss-limit, drawdown-limit, miscalibration, storage-unavailable. Alert ids are deterministic and inserted with
`INSERT OR IGNORE`, so a condition is delivered once. Failed deliveries stay `pending` and are retried.

## Scheduler Worker
`workers/edge-intelligence-scheduler.js` runs every 15 minutes (Pages Functions cannot host cron triggers) and shares
the `JPTI_DB` database. Deploy with `.github/workflows/edge-intelligence-scheduler.yml` (runs after the Pages deploy,
or manually) or:
`npx wrangler deploy --config workers/edge-intelligence-scheduler.wrangler.toml`.
Secrets (set with `wrangler secret put … --config workers/edge-intelligence-scheduler.wrangler.toml`):
`JPTI_ALERT_WEBHOOK_URL` (https only), `JPTI_ALERT_WEBHOOK_SECRET` (adds `x-jpti-signature: sha256=<hmac>`),
`JPTI_TELEGRAM_BOT_TOKEN`, `JPTI_TELEGRAM_CHAT_ID`. Thresholds: `JPTI_ALERT_MIN_SEVERITY`, `JPTI_ALERT_ON_WATCH`,
`JPTI_ALERT_MAX_CONSECUTIVE_LOSSES`, `JPTI_ALERT_DAILY_LOSS_R`, `JPTI_ALERT_DRAWDOWN_R`.
`GET <worker>/health` reports readiness without secrets.

## Walk-forward and Monte Carlo
`npm run backtest:walkforward -- candles.json --symbol BTC/USDT --timeframe 1h --grid balanced,alpha,precision`
selects a preset on each training window, tests it on the following unseen window (an embargo of `maxHold` bars separates
them; no lookahead), and reports out-of-sample metrics, parameter stability, walk-forward efficiency, a verdict
(`insufficient`, `failing`, `fragile`, `robust`) and a seeded Monte Carlo drawdown/ruin estimate.
Exit codes: 0 ok, 1 invalid input, 2 not enough candles.

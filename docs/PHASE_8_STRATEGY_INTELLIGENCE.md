# Phase 8 — Unified JPTI / T-Bots Strategy Intelligence

## Scope

Phase 8 connects the universal strategy registry, persistent paper-trade history, portfolio-wide risk state and the T-Bots paper-entry pipeline. It is local-first: the Node API and ledger run on the Windows host; Android remains a client of that host API. No Cloudflare deployment or hosted JPTI backend is required.

## Strategy scorecards

**Endpoint:** `GET /api/universal/strategy/scorecards?days=90&minTrades=20`

- Reads persisted T-Bots `paper_closed` events only.
- Separates results by strategy profile and reports trade count, win rate, net paper PnL, expectancy per trade, average win/loss, profit factor and maximum closed-trade drawdown.
- Breaks counts down by recorded asset class and venue.
- Marks sample quality as `insufficient_sample`, `early_sample` or `usable_for_review`.
- Defaults to a 90-day lookback and 20 trades for the usable-for-review label; request bounds are clamped.
- Exchange fills and paper results are not mixed. Scorecards are historical descriptions, not predictive probabilities.

## Paper-entry preflight

**Endpoint:** `POST /api/universal/entry-preflight`

The endpoint checks:
- A known strategy profile and its required evidence.
- Evidence timestamp freshness, using server-side `JPTI_TBOTS_PREFLIGHT_MAX_EVIDENCE_AGE_SECONDS` (15–300 seconds; default 90).
- Shared persisted portfolio/risk gates, including global pause, consecutive paper losses and daily realized-loss limits.
- Token-security status for token / DEX / meme / new-pair asset classes.

The endpoint can return only `paper_candidate` or `blocked`. It never submits an order, never enables live trading and never overrides exchange/account limits. Token-security status is supplied by the local T-Bots caller after its own rug/security checks; it is not an independent third-party attestation. A passing result is not a profitability claim.

## T-Bots enforcement

When the authenticated JPTI bridge is configured:
- T-Bots attaches the JPTI preflight callback to its orchestrator.
- The callback runs after the local rug check and before sizing / paper entry.
- A failed, stale, incomplete, unavailable or blocked preflight prevents that new paper entry.
- Existing open positions continue to run their configured exit logic.
- The preflight result is written to the T-Bots task ledger for auditability.
- If the JPTI bridge is not configured, standalone T-Bots mode remains available; shared JPTI gates are not represented as active.

## Configuration

```dotenv
JPTI_TBOTS_MAX_CONSECUTIVE_LOSSES=3
JPTI_TBOTS_DAILY_LOSS_LIMIT_USD=100
JPTI_TBOTS_PREFLIGHT_MAX_EVIDENCE_AGE_SECONDS=90
```

Risk thresholds should be deliberately configured and validated in paper mode. Invalid risk configuration fails closed for the preflight.

## Validation

Run locally:

```bash
npm install
npm run check
npm test
npm run build
```

For the T-Bots adapter, `npm run check` applies the guarded overlay and syntax-checks the integrated files. If an upstream T-Bots file differs from its recorded baseline, the adapter script stops rather than overwriting the upstream change.

## Explicit non-goals

- No autonomous live order placement.
- No live execution approval based on strategy scorecards.
- No assumption that a passing heuristic score means a profitable strategy.
- No combining unlike quote currencies without a verified FX conversion.
- No Cloudflare integration.
- No automatic ledger replication between Windows and Android devices.

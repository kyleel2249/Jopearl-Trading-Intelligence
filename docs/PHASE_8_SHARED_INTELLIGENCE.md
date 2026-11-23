# Phase 8 — JPTI and T-Bots shared intelligence feedback

This phase hardens the local JPTI ↔ embedded T-Bots connection. T-Bots remains a paper-execution engine; JPTI remains the shared market-intelligence, risk and durable event-ledger service.

## Durable paper-event delivery

- T-Bots now writes outbound agent events to a bounded browser-local outbox before attempting delivery.
- Events are delivered sequentially and removed only after JPTI acknowledges them.
- Failed deliveries remain queued with capped exponential retry backoff and survive a T-Bots page reload when browser local storage is available.
- Each event receives a deterministic run-scoped sequence ID. Retries therefore reuse the same external ID and JPTI's append-only ledger idempotency prevents duplicate ingestion.
- The queue is capped at 500 events by default. It never silently discards the oldest event when full; a visible delivery status is available from `JptiBridge.deliveryStatus()`.
- The API token is not stored in the outbox or browser storage. It remains in the bridge's runtime memory.

If browser storage is unavailable, delivery remains best-effort in memory and the bridge reports `memory-only` persistence.

## Shared risk feedback

- T-Bots publishes its paper-equity balance and peak equity with trade events and session recaps.
- JPTI calculates the latest observed paper-equity drawdown from the persisted event journal.
- New paper entries are paused when the configured shared drawdown threshold is reached, in addition to the existing global pause, consecutive-loss and rolling 24-hour USD loss controls.
- The default shared paper drawdown threshold is 10%; configure `JPTI_TBOTS_MAX_DRAWDOWN_PCT` between 1 and 50.
- If equity telemetry is absent, JPTI returns a null drawdown estimate rather than inventing one.
- T-Bots rejects missing, invalid or older-than-45-second shared-risk snapshots. A stale or unavailable risk service fails closed for new entries; existing paper-position exit management remains enabled.

## Validation

- Deterministic API tests cover drawdown-triggered entry pauses, missing telemetry and invalid configuration fallback.
- Bridge tests cover queued delivery across a simulated restart, stable idempotency IDs, stale risk rejection and preservation of an active pause.
- `npm run check`, `npm test` and `npm run build` are the required CI gates.

## Boundaries

- This is a local-first integration. Windows runs the JPTI API and durable ledger; Android connects to that API over a trusted private network or VPN.
- The outbox is local to the T-Bots browser profile. It is not a multi-device synchronization service.
- The shared risk gate controls T-Bots paper entries only. It does not cancel exits, submit exchange orders, transfer funds or enable live trading.
- A paper drawdown guard is not a substitute for exchange-side account risk controls or a fully reconciled live portfolio equity calculation.

# Elite Trader Replication Division (ETRD)

ETRD is an independent JPTI subsystem for evidence-gated evaluation of Bitget elite-trader candidates. It has a separate 15-agent roster and stores ranking snapshots in the existing `JPTI_DB` / `jpti_events` event store.

## Current implementation

- Deterministic 100-point candidate scoring with explicit component scores.
- Hard eligibility gates for source freshness, at least 100 trades, 90 days of history, at least three ROI windows, positive ROI, positive copier PnL, and maximum drawdown no greater than 25%.
- 7d / 30d / 90d / 180d performance-window coverage.
- Risk flags for elevated drawdown, unusually high win rates on small samples, high leverage, recovery trading and concentrated exposure.
- Top-100 candidate assessment and top-10 eligible paper-replica shortlist.
- Protected API and durable ranking history in Cloudflare D1.
- Live execution is hard-disabled in this release. Ranking never creates exchange orders.

## API

- `GET /api/elite-traders` — public capability and agent roster metadata.
- `POST /api/elite-traders` — protected ranking run. Send `x-jpti-api-token` or `Authorization: Bearer ...` using the existing JPTI private token.
- `GET /api/elite-traders?limit=20` — protected ranking history.

POST body shape:

```json
{
  "candidates": [
    {
      "traderId": "provider-trader-id",
      "displayName": "Trader display name",
      "source": "provider-name",\n      "sourceAttested": true,
      "sourceUrl": "https://provider.example/profile",
      "retrievedAt": "2026-11-26T12:00:00.000Z",
      "totalTrades": 500,
      "historyDays": 240,
      "averageHoldingHours": 8,
      "maxLeverage": 5,
      "windows": {
        "7d": {"roiPct": 2, "winRatePct": 62, "maxDrawdownPct": 4, "copierPnlUsd": 120},
        "30d": {"roiPct": 8, "winRatePct": 64, "maxDrawdownPct": 7, "copierPnlUsd": 550},
        "90d": {"roiPct": 18, "winRatePct": 63, "maxDrawdownPct": 9, "copierPnlUsd": 1800, "sharpe": 1.8, "sortino": 2.1, "calmar": 1.6},
        "180d": {"roiPct": 28, "winRatePct": 62, "maxDrawdownPct": 10, "copierPnlUsd": 3200}
      }
    }
  ]
}
```

The sample above documents the schema only; it is not a real trader or a live result. Never submit synthetic metrics as actual candidates. The sourceAttested flag is an operator attestation, not independent verification; the system continues to label the provenance unverified until reconciliation is implemented.

## Data-source and automation requirements

The system deliberately does not fabricate a Bitget trader feed. A verified source adapter still needs to be connected and tested against the current Bitget API or a separately approved provider. Provider-reported metrics are labelled unverified until reconciled. The public trader leaderboard is not proof of copier returns, fills, or execution quality.

Continuous unattended refresh requires a Cloudflare Cron Trigger (or another reliable scheduler), a configured feed adapter, freshness/duplicate controls, alert delivery, and monitored D1 persistence. The API reports scheduled monitoring as unconfigured until that infrastructure is present.

## Capital and execution controls

This subsystem is paper-only. No private Bitget credentials are consumed and no order endpoint is exposed. Live copy trading must be a separate reviewed release with least-privilege trade permissions, no withdrawal permissions, per-trader and portfolio exposure caps, max daily loss, max drawdown circuit breaker, stale-feed rejection, idempotent order intents, reconciliation, kill switch, and explicit operator authorization. A trader score alone must never authorize capital.

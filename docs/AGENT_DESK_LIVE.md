# Agent Desk Live

Read-only operator view that merges two existing JPTI data sources into one animated desk.

## Data flow

| Panel | Source | Notes |
| --- | --- | --- |
| Agent orbit (10 nodes) | `runAgentFleet` in `src/agent-fleet-engine.js`, evidence built from `/api/exchanges/{ex}/ohlcv/{pair}` (5m, 15m, 1h) and optional `/api/intelligence/market/{ex}/{pair}/context` | Same deterministic specialists as the AI Agent Command Center. Missing evidence is reported as `no data`; stale evidence as `stale`. |
| Fleet consensus | Same fleet result | Uses the fleet's own risk gate (`NO_TRADE`, `WAIT_FOR_CONFIRMATION`, `REVIEW_SETUP`). |
| Equity, roster, recap, log | `/api/paper/overview` (private, same-origin) | Virtual `$1` per agent ledger. If the private API token is not set, the paper panels show the error and the orbit keeps working. |
| Candles / equity curve | Same sources, drawn on canvas | Curve starts at the real starting capital; history is cached in `localStorage` (non-sensitive). |

## Files

- `src/agent-desk-engine.js` - pure mapping and reducer (tested in `src/agent-desk-engine.test.js`).
- `src/desk-charts.js` - canvas drawing.
- `src/AgentDeskLive.jsx` / `.css` - the workspace; registered in `src/App.jsx` and the terminal `OPEN` allowlist.

## Safety

No exchange order API is imported. `permissions.ordersCreated` stays 0, live execution stays unauthorised, and the header shows `LEDGER UNVERIFIED` if the ledger does not report `PAPER_ONLY`. Polling pauses while the tab is hidden and honours `prefers-reduced-motion`.

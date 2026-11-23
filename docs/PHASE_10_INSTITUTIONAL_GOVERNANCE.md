# Phase 10 — Institutional AI Governance & Execution Intelligence

## Scope
Phase 10 formalizes strategy scorecards, paper-entry preflight, T-Bots feedback and persisted operator controls into an institutional governance layer. It remains local-first and paper-only. No new live order path is introduced.

## Institutional strategy scorecards
GET /api/universal/institutional/scorecards?days=90&minTrades=20 reports T-Bots paper-only outcomes by strategy profile: closed-trade count, win rate and Wilson 95% confidence interval; net PnL, expectancy, average win/loss, profit factor and closed-trade drawdown; per-trade Sharpe and Sortino (descriptive, not annualized); average/max slippage, average fill ratio when explicitly supplied, average holding time; venue/asset-class breakdown, loss streaks and sample quality.
Exchange fills and live trades are not mixed with simulated paper outcomes.

## Strategy qualification and sizing
POST /api/universal/entry-preflight layers institutional governance over existing strategy evidence and shared risk preflight.
- New or insufficiently sampled strategies may enter only a restricted paper trial, default maximum size 1.00% of paper equity.
- Paper validation requires at least 20 closed paper trades, positive expectancy and profit factor >= 1.05 (configurable).
- A mature strategy failing expectancy or profit-factor criteria is suspended from new paper entries.
- Validated paper strategies remain capped at 2.00% equity by default.
- T-Bots enforces the returned cap at the final sizing boundary. Missing, invalid or absent caps block new entries.

Configuration: JPTI_GOVERNANCE_MIN_CLOSED_TRADES=20; JPTI_GOVERNANCE_MIN_PROFIT_FACTOR=1.05; JPTI_GOVERNANCE_MAX_TRIAL_SIZE_PCT=1; JPTI_GOVERNANCE_VALIDATED_SIZE_PCT=2.

## T-Bots feedback loop
Closed paper trade events persist execution slippage, entry/exit prices and holding duration. JPTI scorecards consume these events as measured execution-quality evidence. The T-Bots bridge no longer caches entry approvals: every new entry calls the authoritative JPTI gate. Live-market-data paper sessions require an authenticated JPTI bridge; standalone simulated sessions remain available.

## Fail-closed controls
- GET /api/universal/safety/status returns persisted kill-switch state and paper-only safety posture.
- POST /api/universal/safety/kill-switch with action=engage persists a global entry stop.
- Release requires action=release and confirmation=I_CONFIRM_RESUME_PAPER_ENTRIES.
- Kill switch blocks new JPTI-governed T-Bots paper entries. Existing position exit logic remains active.
- Missing API, unreadable ledger, stale evidence, invalid risk configuration, missing governance cap or rejected preflight blocks new entries.
- This control does not grant live execution authorization.

## Validation
npm install; npm run check; npm test; npm run build. Root validation applies the guarded T-Bots adapter and stops rather than overwriting unexpected upstream file drift.
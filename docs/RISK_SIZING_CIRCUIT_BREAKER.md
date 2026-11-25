# Position sizing and circuit breaker

Two pure, dependency-free libraries with tests (`tests/position-sizing.test.js`, `tests/circuit-breaker.test.js`).
They are **not yet wired into** the paper-trading API, which already enforces its own daily-loss circuit and
drawdown suspension in `functions/api/paper/[[path]].js`. Wire them in only with D1 and build verification.

## `src/lib/position-sizing.js`
- `fixedRiskSize({ side, equity, riskPercent, entry, stop, feeBps, lotStep, minQuantity, maxNotional, maxPositionPercent })`
  sizes so a stop-out loses `riskPercent` of equity, fees on both legs included. Invalid input returns `{ valid: false, reason }`.
- `atrStop`, `volatilitySize` derive a stop from ATR and size from it.
- `kellyFraction`, `kellyRiskPercent` give a fractional-Kelly risk percent, capped, and zero without an edge or 30+ trades.

## `src/lib/circuit-breaker.js`
Immutable state: `createBreaker`, `recordTrade`, `canTrade`, `tick`, `resume`.
- Drawdown trip: manual `resume({ by, reason })` required.
- Daily-loss trip: clears at the next UTC day via `tick`.
- Consecutive-loss trip: clears after `cooldownMs`.
Persisting the state is the caller's job.

# Phase 9 — Institutional Terminal & Operator Experience

## Scope
Phase 9 adds a dedicated institutional command terminal and a refined visual system while preserving the existing React/Vite, Node.js and CCXT architecture. The feature is local-first and designed for desktop and Android browser/Capacitor layouts.

## Operator terminal
The terminal accepts only an allowlisted command grammar:
- `HELP`, `STATUS`, `REFRESH`, `RISK`
- `OPEN <workspace>`
- `SYMBOL <BASE/QUOTE>`
- `WATCH <BASE/QUOTE>`
- `UNWATCH <BASE/QUOTE>`

It does not expose a shell, JavaScript evaluation, arbitrary process execution, exchange order submission or withdrawal capability. Unknown commands and malformed inputs are rejected. Workspace and symbol inputs are validated before use.

## Market watch
The terminal queries the existing public cross-venue ticker endpoint for Binance, Bitget, Bybit and OKX. It displays median last price, responding venue count and observed price dispersion. This is indicative public ticker data only; it is not a depth-aware executable quote or arbitrage instruction. A local watchlist of up to 12 normalized markets is stored in browser local storage; no credentials are stored there.

## Risk and operations
Gateway health and scheduler telemetry use existing JPTI endpoints. The risk panel calls the existing authenticated portfolio-risk endpoint and displays the API's own observations, warnings and limitations. A missing token, missing local-private-access permission or missing ledger marks returns an honest error/empty state rather than invented figures.

## Visual system
The new terminal uses an institutional navy foundation with disciplined blue, cyan, emerald, violet and amber accents, clear typography hierarchy, restrained gradients, accessible controls, mobile breakpoints and reduced-motion handling. Existing workspaces receive a coordinated refinement through additive CSS overrides.

## Safety and verification
- Paper-first behavior is unchanged; Phase 9 adds no order execution route.
- Existing live-trading gates are not weakened.
- Market observations remain read-only.
- Terminal command parsing has unit tests for valid commands, normalization and unsafe/unknown input rejection.
- Run `npm test`, `npm run check` and `npm run build` before merge.

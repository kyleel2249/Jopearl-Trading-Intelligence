# Chart zone verification scope

This validation branch targets the current scalping/day-trading and multi-asset integration branch. Its CI run validates the complete combined tree, including:

- Shared ATR-scaled liquidity-band geometry.
- TP1/TP2/TP3 target-band geometry and three-target plan generation.
- The single-chart and multi-chart shared live-candlestick rendering path.
- Existing specialist squad, market-regime, capital-protection, paper-cycle, multi-asset and D1 integration suites.

The chart-zone geometry unit tests live in `src/chart-intelligence/chart-zones.test.js` and are included in the standard Node test discovery used by `npm test`.

Visual band widths are deliberately presentation tolerances. They do not imply actual resting liquidity, guaranteed fills or autonomous live execution.

# T-Bots ↔ JPTI unified multi-asset integration

T-Bots remains an embedded six-agent paper engine. Its live discovery feed now consumes DexScreener's latest token profiles across supported chain IDs rather than hard-coding Solana. Market pairs are grouped by chain and fetched through the chain-specific token-pairs endpoint. Solana candidates are enriched with RugCheck; supported EVM candidates are enriched with GoPlus token-security data. Unknown chains, missing responses and incomplete security evidence fail closed at the Rug Check agent.

## Coverage and limits

- Discovery is based on DexScreener's latest token-profile feed and pair endpoints. This is a broad, changing discovery universe, not every token pair on every blockchain and not a complete chain archive.
- Supported GoPlus EVM mappings include Ethereum, BNB Chain, Polygon, Arbitrum, Optimism, Base, Avalanche, Linea and Blast. Solana uses RugCheck. Other chains remain fail-closed until a validated security adapter is added.
- Security field coverage differs by provider. An LP lock percentage is not the same as a verifiable lock duration. Missing/unsupported fields do not count as a pass.
- Legacy strategies remain new-pair oriented: age, liquidity, recent volume, holder/security checks and six-agent orchestration still apply. This is not a validated strategy for every asset class.
- DEX token pairs are not the same as CEX spot/perpetual contracts. JPTI's CCXT market catalog and provider/on-chain intelligence remain available through their own APIs; matching symbols do not imply identical instruments or executable routes.
- The DEX executor remains paper/simulated. No wallet signing, DEX swap routing, bridging, withdrawals or live wallet execution is enabled.

## JPTI endpoints

All routes require the x-jpti-api-token header.

- GET /api/integrations/tbots/universe?q=token-or-project — search multi-chain DEX pairs through DexScreener, normalize chain/token/pair metadata and attach a heuristic evidence score. Cached for 30 seconds.
- GET /api/integrations/tbots/risk — summarize published T-Bots closed paper trades, win/loss counts, recent loss streak and shared entry-pause decision.
- GET /api/integrations/tbots/memory?limit=50 — recent T-Bots events from the shared JPTI append-only ledger.
- GET /api/integrations/tbots/context?exchange=binance&symbol=BTC%2FUSDT — selected centralized-market context (ticker, 1h momentum, order-book imbalance, funding where supported and coarse regime).

## Shared risk behavior

T-Bots refreshes selected-market context and shared risk state during live-data sessions. A risk-off selected-market regime or shared memory pause blocks new entries; existing paper positions continue through normal exit management. Three or more consecutive losing closed paper trades trigger the shared memory pause. If the risk endpoint is unavailable, the integration fails closed for new entries. This is not yet a consolidated cross-exchange portfolio equity/drawdown calculation: JPTI exchange portfolio risk and T-Bots paper equity remain separately accounted.

## Run

Start JPTI API and UI with npm run dev:all, open http://localhost:8787/t-bots/, and enter the local JPTI_API_TOKEN in the T-Bots connection field. Keep API credentials server-side. Use paper mode.

## Universal engine extension

T-Bots now has selectable DEX scan profiles in the session composer:
- `meme_new_pair` — strict recent-pair screen.
- `established_token` — removes the new-pair age ceiling while retaining liquidity, holder and independent security checks.
- `defi_rotation` — monitor-only until a verified token-to-protocol mapping, TVL change, fees change and protocol-risk score are available.
- `breakout` — liquid token momentum-breakout discovery; it is not a validated range-breakout/retest strategy.
- `mean_reversion` — requires JPTI RSI14 evidence; the current automatic RSI source is the configured CEX 5-minute feed. DEX tokens without RSI are blocked from new entries.

When the JPTI bridge is connected, the live feed also merges a server-configured DEX contract watchlist (for established/older tokens) and a CEX spot watchlist with the live multi-chain DEX discovery feed. Configure in the JPTI server-side `.env`:

```env
JPTI_TBOTS_DEX_WATCHLIST=solana:YourSolanaMint,base:0xYourTokenContract
JPTI_TBOTS_CEX_MARKETS=binance:BTC/USDT,binance:ETH/USDT,binance:SOL/USDT,bitget:BTC/USDT,bitget:ETH/USDT
JPTI_TBOTS_MAX_CONSECUTIVE_LOSSES=3
JPTI_TBOTS_DAILY_LOSS_LIMIT_USD=100
```

Only active CEX spot markets are admitted to the T-Bots CEX paper feed. The exchange-market gate requires at least $100,000 24h quote volume, $10,000 visible top-book depth and spread no wider than 0.5%. CEX pairs are not passed through DEX mint/holder checks; they use an exchange-listing, liquidity and spread gate instead. CEX perpetuals, options and leveraged execution are not routed through the T-Bots executor.

T-Bots requests fresh per-asset evidence from JPTI before new entries. If the evidence is missing, stale or below the minimum research score, new entries are blocked. The JPTI shared risk endpoint incorporates T-Bots closed paper PnL and quote-aware realized PnL from recorded exchange fills. USD, USDT, USDC, DAI and FDUSD are treated as approximate USD equivalents for the daily loss guard; other quote currencies remain separate until FX conversion is available. The risk guard does not claim to consolidate unrealized PnL, deposits, withdrawals, funding or unrecorded fills.

## Universal JPTI endpoints

- `GET /api/universal/profiles` — strategy profile registry and asset-class mapping.
- `POST /api/universal/strategy/evaluate` — deterministic evidence evaluation for a selected profile; research-only.
- `GET /api/universal/market/:exchange/:symbol?timeframe=1h` — ticker, OHLCV, multi-timeframe trend, RSI, order-book depth, funding/open interest where supported, and evidence council.
- `GET /api/universal/dex-watchlist` — authenticated configured DEX contract-address watchlist.
- `GET /api/universal/cex-watchlist` — authenticated configured CEX spot market feed for T-Bots.
- `POST /api/universal/asset-evidence` — authenticated batch evidence scoring for DEX and CEX instruments.
- `GET /api/universal/asset/:chain/:address` — authenticated DEX pair and provider-specific token security observations (RugCheck for Solana, GoPlus for selected EVM chains).
- `GET /api/universal/dex/search?q=...` — authenticated multi-chain DEX search.
- `GET /api/universal/macro` — CoinGecko global crypto, DeFiLlama chain TVL and optional FRED FEDFUNDS observation.
- `GET /api/universal/news?q=...` — GDELT news discovery.
- `GET /api/universal/risk` — authenticated unified new-entry gate, daily realized loss and consecutive paper loss state.
- `GET /api/universal/performance` — authenticated T-Bots paper performance and exchange fill attribution.

## Boundaries still in force

- The JPTI strategy registry spans crypto, DEX tokens, equities, FX, commodities, indices and bonds, but a profile existing does not mean the corresponding live feed, trading venue, or strategy has passed validation. The T-Bots executor supports DEX paper positions and selected CEX spot paper instruments only.
- CEX spot pairs are explicitly configured in `JPTI_TBOTS_CEX_MARKETS`; it does not subscribe to every market from every exchange automatically.
- DeFi rotation has no universal token-to-protocol entity resolver yet. A token symbol is not sufficient proof of protocol identity.
- Macro and news sources provide context, not automated sentiment labels or guaranteed predictive value. FRED observations can be delayed and require `JPTI_FRED_API_KEY`.
- Unified realized-risk accounting uses recorded fills and T-Bots paper closes. It does not yet combine open CEX/DEX positions, cash balances, unrealized PnL, cross-currency FX, deposits/withdrawals, funding, borrow or transfers into one verified account equity curve.
- No production database/event bus, exchange WebSocket client, DEX swap router, wallet signing or live T-Bots execution is enabled.


### Shared global regime and derivatives

The JPTI bridge now prefers a Binance BTC/USDT perpetual benchmark through the Universal Engine, collecting OHLCV, multi-timeframe trend, order-book depth, funding and open-interest where the adapter supports them. It falls back to the earlier BTC spot context if the perpetual market is unavailable. T-Bots also refreshes CoinGecko global crypto market metrics, DeFiLlama chain TVL and optional FRED FEDFUNDS context. A broad crypto market-cap fall of 8% or more over 24 hours pauses new entries; BTC benchmark risk-off state and the shared realized-loss guard can also pause new entries. Existing exits remain enabled.


### Central operator kill switch

The Universal Engine workspace exposes pause/resume controls for T-Bots new entries. The API persists `global_pause` / `global_resume` events in the JPTI ledger. Connected T-Bots instances consume the latest state through the shared-risk refresh (nominally every 30 seconds). A pause blocks new entries across the connected T-Bots paper engine; existing positions retain exit management. This is a new-entry kill switch, not a forced liquidation command or a live exchange cancellation endpoint.

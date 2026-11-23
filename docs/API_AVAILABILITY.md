# JPTI API availability

The supported production API host is Cloudflare Pages Functions, deployed with the JPTI frontend on the same origin. No Render service, separate Node API host, manually entered API gateway URL, or gateway token is needed for public market charts.

The Cloudflare edge API currently supports public exchange catalogs, tickers, cross-venue public ticker comparison and OHLCV candlesticks for Binance, Bybit, OKX and Bitget. It is read-only. Private account endpoints, order execution, durable portfolio services, scheduler tasks and Node-backed advanced analytics are not yet ported to Cloudflare and return explicit unsupported-route responses.

When chart data is unavailable, check the selected exchange, symbol and timeframe, then inspect Cloudflare Pages Function logs and the exchange's public API status. Exchanges can rate-limit or interrupt requests; Cloudflare hosting cannot guarantee that external market providers are always reachable.

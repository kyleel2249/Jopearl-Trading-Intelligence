# JPTI Instrument Precision Intelligence

Instrument-specific tick size and pip size are the source of truth. Consumers should pass market metadata from the exchange/provider when available.

- `resolvePrecision(metadata)`: tick size, pip size, precision and provenance.
- `roundToTick(price, metadata)`: tick-aware rounding; decimal fallback only when metadata supplies precision.
- `formatInstrumentPrice(price, metadata, options)`: presentation formatter.
- `priceDistanceInPips(from, to, metadata)`: pip-distance calculation; returns null when pip size is unknown.
- `pricePrecisionDiagnostics(metadata)`: reports gaps rather than inventing tick/pip rules.

Metadata examples:
```js
{ symbol: "EUR/USD", tickSize: 0.00001, pipSize: 0.0001, priceDecimals: 5, marketType: "forex" }
{ symbol: "USD/JPY", tickSize: 0.001, pipSize: 0.01, priceDecimals: 3, marketType: "forex" }
{ symbol: "BTC/USDT", tickSize: 0.01, priceDecimals: 2, marketType: "spot" }
```

Forex pip conventions vary by provider, contract and quote precision. These examples are illustrative; do not hardcode them into live instrument catalogs. CFD/metal/index/derivative metadata must be sourced from the selected provider's instrument catalog.

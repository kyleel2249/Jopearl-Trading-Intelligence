# Environment validation

The repository contains `scripts/check-env.mjs` and exposes it as:

```bash
npm run env:check
```

The validator checks frontend environment files for secret-like Vite variable names, validates API and WebSocket URL formats, and warns when the API origin is blank. It does not print environment values.

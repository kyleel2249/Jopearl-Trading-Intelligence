# GitHub Actions → Cloudflare Pages environment synchronization

JPTI uses GitHub Actions as the configuration source for CI/CD and Cloudflare Pages as the runtime host.

## Required GitHub Actions repository secrets

Add these under **Repository → Settings → Secrets and variables → Actions → Secrets**:

- `CLOUDFLARE_API_TOKEN`: Cloudflare API token with Pages Write, Workers Scripts Write (for the existing Worker deploy), and D1 edit permissions required by the current workflow.
- `CLOUDFLARE_ACCOUNT_ID`: Cloudflare account ID.
- `JPTI_CLOUDFLARE_SECRETS_JSON`: optional JSON object containing encrypted Pages runtime secrets.

Example value for `JPTI_CLOUDFLARE_SECRETS_JSON` (replace the placeholders with real values; never commit this file):

```json
{
  "JPTI_BITGET_API_KEY": "replace-me",
  "JPTI_BITGET_API_SECRET": "replace-me",
  "JPTI_BITGET_API_PASSPHRASE": "replace-me"
}
```

The JSON secret is passed to Wrangler's Pages secret bulk command. Secret values are not printed in workflow logs. Keys beginning with `VITE_` are rejected because Vite variables are embedded in public browser assets.

## GitHub Actions repository variables

Add these under **Repository → Settings → Secrets and variables → Actions → Variables**:

- `CLOUDFLARE_PAGES_PROJECT`: optional; defaults to `jpti`.
- `CLOUDFLARE_PAGES_URL`: public deployed Pages URL used by the live verification step.
- `VITE_APP_NAME`: defaults to `JPTI`.
- `VITE_APP_ENV`: defaults to `production`.
- `VITE_API_BASE_URL`: normally blank for Pages same-origin Functions.
- `VITE_WS_URL`: optional secure WebSocket origin.
- `VITE_ENABLE_ANALYTICS`, `VITE_ENABLE_CRASH_REPORTING`, `VITE_ENABLE_PERFORMANCE_MONITORING`, `VITE_ENABLE_CONFIG_DIAGNOSTICS`: public feature flags.

All `VITE_*` GitHub Variables are picked up automatically and written to the Vite production environment file before the build.

## Additional runtime variables

For runtime variables not covered by the allowlist, add a repository variable named `JPTI_CLOUDFLARE_VARS_JSON` containing a JSON object. Example:

```json
{
  "JPTI_ALERT_MIN_SEVERITY": "warning",
  "JPTI_ALERT_MAX_CONSECUTIVE_LOSSES": "4",
  "JPTI_ALERT_DAILY_LOSS_R": "3",
  "JPTI_ALERT_DRAWDOWN_R": "6"
}
```

The workflow also automatically syncs allowlisted `JPTI_ALERT_*`, `JPTI_CORS_*`, `JPTI_EVENT_RISK_*`, `JPTI_ENABLE_*`, `JPTI_CROSS_VENUE_*`, `JPTI_TRADING_MODE`, and `JPTI_TRUST_PROXY` variables.

## What the workflow does

1. Reads GitHub Actions Variables and the optional JSON configuration maps.
2. Creates a temporary Wrangler configuration by copying the existing root `wrangler.toml` and appending a `[vars]` table. Existing D1, KV and AI bindings remain intact. The workflow activates that generated file as the root `wrangler.toml` inside the ephemeral GitHub runner because Cloudflare Pages rejects custom Wrangler config paths.
3. Writes `VITE_*` values to an ignored `.env.production.local` file for the browser build.
4. Builds and tests JPTI.
5. Uploads encrypted Pages secrets with `wrangler pages secret bulk`.
6. Deploys Pages using the root Wrangler configuration, syncing runtime variables to production and preview. The deploy command intentionally omits `--config`; Pages requires its default root config path.
7. Continues the existing D1 migration, scheduler deployment and live Bitget verification steps.

The sync is additive/update-only: supplied keys are created or updated; keys omitted from GitHub are not deleted. This prevents an empty or partial GitHub configuration from wiping existing production settings. Remove obsolete keys explicitly in Cloudflare after reviewing their usage.

## Manual synchronization

Run **Actions → Deploy JPTI to Cloudflare Pages → Run workflow**. The existing deployment checks run before the production deployment.

## Security notes

- Never store credentials in GitHub Variables or any `VITE_*` variable.
- Never commit `.env.production.local`, `.jpti-pages-secrets.json`, or generated Wrangler config files.
- Keep Cloudflare API tokens scoped to the minimum permissions required.
- Use different GitHub Environments and credentials if separate staging and production accounts are introduced.
- The Pages sync applies to the Pages project. Separately deployed Workers have their own runtime variable and secret configuration.

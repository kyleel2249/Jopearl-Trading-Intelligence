# Environment configuration

## Vite build variables

The root `.env.example` lists public browser configuration. Vite embeds every `VITE_*` value in the client bundle, so only non-secret values belong there. For Cloudflare web deployments leave `VITE_API_BASE_URL` blank; the app uses its own Pages origin.

## Cloudflare Functions

Use `.dev.vars` for local Pages Functions variables and Cloudflare dashboard Variables/Secrets for production. Do not commit `.dev.vars`. Public market data does not require credentials. Private exchange credentials are not currently consumed by the Pages edge adapter.

## Deployment credentials

GitHub Actions requires `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. These are deployment credentials and must remain GitHub secrets. `CLOUDFLARE_PAGES_URL` is an optional public URL for native Android builds.

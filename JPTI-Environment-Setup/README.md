# JPTI Cloudflare environment setup

JPTI web hosting and its public market-data API run on Cloudflare Pages. No Render API, external API gateway URL, or API token is required for public charts.

- Copy the root `.env.example` to `.env` for Vite build settings.
- Copy `.dev.vars.example` to `.dev.vars` for local Pages Functions variables.
- Configure `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as GitHub Actions secrets for deployment.
- Optionally configure `CLOUDFLARE_PAGES_URL` as a repository variable for Android builds.

Never put private credentials in `VITE_*` variables. The current Cloudflare edge API is read-only and supports public market data. Legacy Node API variables do not activate Node-only backend services inside Cloudflare Pages.

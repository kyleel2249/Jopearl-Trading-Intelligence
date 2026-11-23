# JPTI mobile connection

JPTI's web application and public market-data API are hosted together on Cloudflare Pages.

1. Deploy the `jpti` Pages project and wait for the deployment to finish.
2. Confirm `https://YOUR-PAGES-HOST/api/health` returns JSON with `mode: cloudflare-edge`.
3. For the Android build workflow, set the GitHub Actions variable `CLOUDFLARE_PAGES_URL` to the public Pages origin (for example `https://jpti.pages.dev`).
4. No external API gateway URL, gateway token, Render service or exchange API key is required for public market charts.
5. Open Connection Settings and tap **Check Cloudflare connection**.

The current edge runtime is read-only and serves public market data. Private exchange account access, order execution, durable portfolio records and server-backed engines are not yet ported to Cloudflare.

Never put private credentials in `VITE_*` variables or commit `.dev.vars`.

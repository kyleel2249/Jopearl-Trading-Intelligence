# Deployment connectivity

JPTI's supported web deployment is Cloudflare Pages. The app and `/api/*` Functions share one origin, so web clients do not configure an external API gateway URL. The frontend resolves the current Cloudflare Pages origin automatically.

For Android WebViews, set `CLOUDFLARE_PAGES_URL` to the public Pages origin in GitHub Actions variables. This is the Pages app/API origin, not a separate gateway.

Public market-data endpoints need no exchange API keys. Never embed private exchange credentials in `VITE_*` values. Refer to `CLOUDFLARE-PAGES.md` for deployment setup and current Cloudflare runtime capabilities.

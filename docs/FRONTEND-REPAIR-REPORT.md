# JPTI frontend integrity repair

## Root causes found
1. **Wrong base path in native and desktop builds.** `vite.config.js` chose `/JPTI/` whenever `GITHUB_ACTIONS=true`. GitHub sets that for every workflow, so Android (Capacitor) and Electron builds produced `/JPTI/assets/...` URLs while serving from the origin root. Result: 404 bundle, blank screen. `build-apps.yml` also forced the variable explicitly.
2. **Optional third-party failures could break startup.** Firebase Analytics loaded a legacy gstatic script on the web; blocked or offline, it rejected with a bare `Event` (unhandled rejection).
3. **Recovery screen was incomplete.** No retry, no hang watchdog, and a failed optional font stylesheet would have counted as fatal.
4. **Render-blocking font `@import`** at the top of the CSS bundle.
5. **Security:** `.env` containing provider and exchange credentials was tracked in git.

## Changes
See FILE-LOCATIONS.md in the archive.

## Verification actually executed
- `npm run check`: pass
- `npm test`: 366/366 pass (359 existing + 7 new)
- `npm run build` in root mode and with `JPTI_BASE_PATH=/JPTI/`: both succeed; generated HTML references verified
- `npm run smoke`: pass
- Chromium (Playwright) 51/51 checks: mounts with content on desktop, Android-small, iPhone and tablet-landscape viewports; `/JPTI/` base with 404.html fallback on a nested route; root base; no page errors; no 4xx assets; no horizontal overflow; blocked bundle shows recovery screen with retry; hung bundle shows recovery at 15 s; blocked font stylesheet does not break mount

## Not verified (environment limits)
- Push, GitHub Actions run, live Pages inspection (no GitHub credentials)
- Real Android WebView and Electron window runs (Chromium only; Electron/Capacitor config reviewed, both serve from root base)

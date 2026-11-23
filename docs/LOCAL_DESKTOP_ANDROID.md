# JPTI desktop, Android and hybrid deployment

JPTI is a local-first application with two primary runtime surfaces:

1. **Windows desktop application** — Electron starts the Node/Express API locally and stores the event ledger in the user's private application-data directory.
2. **Android application** — Capacitor packages the React interface as a native app. It connects to the same JPTI API running on your PC over a trusted local network or private VPN. The Android package does not bundle the Node/CCXT backend.

There is no Cloudflare, hosted frontend, or hosted API dependency in this project. Windows desktop operation is fully local. Android uses the local PC API; it does not automatically synchronize a separate ledger or send exchange credentials to a cloud service.

## Windows desktop

### Run from source

Requirements: Windows 10/11 64-bit, Node.js 22 LTS, npm.

```powershell
git clone https://github.com/kyleel2249/JPTI.git
cd JPTI
git checkout main
npm install
npm run desktop:dev
```

The desktop shell builds the Vite UI, starts the API on `127.0.0.1:8787`, waits for its health endpoint, then opens a secured Electron window. The API is loopback-only. In desktop mode private read-only portfolio/reconciliation actions may use loopback-only authorization; requests from other machines cannot use that exception. The desktop always forces paper mode and disables live execution. It starts its local API/scheduler when the desktop process launches, even if you later switch the dashboard's Connection Settings to a cloud URL. Do not configure the same exchange accounts/watchlists on both local and cloud schedulers unless you intentionally coordinate them; otherwise you may duplicate polling and ledger ingestion.

### Build Windows installers

```powershell
npm install
npm run desktop:dist
```

Electron Builder writes the Windows NSIS installer and portable executable into `release/`. Use `npm run desktop:pack` for an unpacked diagnostic build. Keep the installer and application data on a trusted device.

### Local files and credentials

The desktop's append-only file ledger and sync cursors live in Electron's private `app.getPath('userData')/data` directory, not in the installation directory or the web build. This protects records from normal application upgrades. The optional local `.env` file is read from `app.getPath('userData')/.env`; it is not included in the installer or Git repository. Back up the application-data directory securely.

For exchange access, use read-only keys and disable withdrawals. Never put exchange keys into Vite variables, frontend source, or the API base URL. Desktop mode is paper-only in this build; it deliberately overrides live-trading environment flags.

## Android app

### Requirements

- Windows 10/11 64-bit
- Node.js 22 LTS and npm
- Android Studio (current stable release)
- Android SDK and platform/build tools installed through Android Studio
- A physical Android device with USB debugging or an Android emulator

### Generate the native Android project (one time)

```powershell
npm install
npm run build
npm run mobile:android:add
npm run mobile:sync
npm run mobile:android:open
```

This generates the native `android/` project from the checked-in Capacitor configuration. Open it in Android Studio, allow Gradle sync, install any SDK components it requests, then run on a connected device/emulator.

### Build a debug APK

```powershell
npm run build
npx cap sync android
cd android
.\gradlew.bat assembleDebug
```

The debug APK is generated at:

`android/app/build/outputs/apk/debug/app-debug.apk`

The repository also runs a GitHub Actions Android build and uploads the APK as the `jpti-android-debug-apk` workflow artifact when that workflow succeeds. Open the relevant Actions run, scroll to **Artifacts**, and download it. The Windows workflow similarly uploads `jpti-windows-desktop` with the installer and portable executable.

Copy that APK to your Android device and install it (allow installation from that trusted source when Android asks). For a distributable release, use Android Studio **Build → Generate Signed Bundle / APK → APK** and protect your signing keystore and passwords. Do not share a debug APK as a production release.

### Connect Android to the local JPTI API

1. Start JPTI on the Windows PC and keep the PC and phone on the same trusted Wi-Fi network, or connect both through a private VPN.
2. Configure the PC API to listen on its LAN interface: set `JPTI_API_HOST=0.0.0.0`, `JPTI_ALLOW_REMOTE_API=true`, and a strong `JPTI_API_TOKEN`. Restrict Windows Firewall access to your trusted Private network.
3. Put a trusted HTTPS reverse proxy or private VPN in front of the PC API. Do not send API tokens over plain HTTP on an untrusted network.
4. Open Android JPTI → **Connection Settings** and enter the PC's local-network HTTPS API origin (no `/api` suffix).
5. Tap **Test connection**, then **Save connection**. Enter the server API token only when a private operation requests it.

Android cannot use `127.0.0.1` to reach your Windows PC; that address refers to the phone itself. The Android app is a local-network client, not a cloud-hosted service. The PC API remains the single source of market data, exchange connectivity and ledger operations.

## Browser / PWA install

The same responsive UI includes a web manifest and service worker. On supported desktop browsers use the browser's **Install app** option; on Android Chrome use **Install app** or **Add to Home screen**. The service worker caches only the application shell/static assets. It deliberately does not cache `/api/*`, exchange responses, private account data or ledger records. Offline shell access is not offline market data.

## Connection settings

The new Connection Settings workspace stores only the API base URL in browser/device local storage. It never stores the private API token or exchange credentials.

- Blank API base: use the current origin. On Electron desktop this is the embedded local API.
- Local PC API HTTPS URL: use the API address of the PC on your trusted network or private VPN.
- Other remote endpoints: HTTPS is required by the client URL validator.
- `localhost` HTTP is allowed for local development only.

Private API tokens remain in the relevant workflow's in-memory input state. For Android-to-PC access, the local API must set `JPTI_API_TOKEN`. The local desktop can authorize private read-only actions from loopback only; it does not enable live trading.

## Android local-network CORS

Configure the API's `JPTI_CORS_ORIGINS` to include the Capacitor Android WebView origin `https://localhost` (the default in `.env.example`). Do not add public origins. Use a strong `JPTI_API_TOKEN` for private API operations. No external edge service or edge secret is required.

## Local data and Android access

- Windows desktop default: local JSONL event ledger in the private user-data directory.
- Android: installed mobile UI client; private data and market data are requested from the local PC API over a trusted local network or VPN.
- PWA: shell/static assets cached only.

There is no automatic two-way device ledger synchronization in this phase. A future sync service must use stable event IDs, idempotent ingestion, explicit source/account identity, authenticated device registration, conflict handling, encryption in transit, and auditable import/export. Until then, choose one authoritative ledger for each trading account and do not operate the same exchange account from separate uncoordinated schedulers.

## Safety boundaries

- Desktop mode is local and paper-only.
- Android uses remote API permissions configured by the server.
- Live orders remain disabled by default.
- Exchange credentials must remain server-side and read-only where possible.
- The mobile app does not contain exchange API keys.
- Do not expose the local Express API to the internet or an untrusted LAN.

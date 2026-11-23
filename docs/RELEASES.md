# JPTI release signing and downloads

## Automated release flow

A push to `main` runs validation, builds the web app, creates Android and desktop packages, and publishes a versioned GitHub prerelease only after all required packaging jobs succeed.

The release version is `0.2.<GitHub Actions run number>`. Packages and SHA-256 checksum files are attached to the release.

- Releases: https://github.com/kyleel2249/JPTI/releases
- Build history: https://github.com/kyleel2249/JPTI/actions/workflows/build-apps.yml
- In-app release center: JPTI → Downloads & Updates

## Android production signing (required for install-over-existing updates)

Until the four Android signing secrets are configured, CI intentionally publishes a debug APK. Debug builds are for testing and cannot update a production-signed installation.

Create the signing key once on a trusted computer:

```bash
keytool -genkeypair -v \
  -keystore jpti-release.keystore \
  -alias jpti-release \
  -keyalg RSA -keysize 4096 -validity 10000
```

Back up `jpti-release.keystore` and its passwords in a secure offline location. **Never regenerate this key for an existing installation.** Android requires updates to use the same signing identity.

Convert the keystore to Base64:

Linux:
```bash
base64 -w 0 jpti-release.keystore
```

macOS:
```bash
base64 < jpti-release.keystore | tr -d '\n'
```

Windows PowerShell:
```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("jpti-release.keystore"))
```

In GitHub, open **Settings → Secrets and variables → Actions → New repository secret** and add:

| Secret | Value |
|---|---|
| `JPTI_ANDROID_KEYSTORE_BASE64` | Base64 output of the keystore |
| `JPTI_ANDROID_KEY_ALIAS` | `jpti-release` (or the alias selected above) |
| `JPTI_ANDROID_STORE_PASSWORD` | Keystore password |
| `JPTI_ANDROID_KEY_PASSWORD` | Key password |

Once all four secrets exist, the Android job creates a signed release APK and AAB. The AAB can be used for a future Play Store release; the APK is attached for direct installation.

### Exact Android APK folder and download locations

The repository now has a persistent, tracked downloads directory:

```
android/app/downloads/
```

After the next successful Android workflow run, CI commits the generated APK into this folder automatically. When signing secrets are configured, the file is `JPTI-Android-release.apk`; otherwise the test build is `JPTI-Android-debug.apk`. The folder is created in the repository ahead of the first build, but the APK file itself appears only after CI completes.

Gradle's native signed APK output is also available at:

```
android/app/build/outputs/apk/release/app-release.apk
```

The Android App Bundle is staged beside the APK:

```
android/app/build/outputs/distribution/JPTI-Android-release.aab
```

The distribution output path is a temporary CI build location. The workflow also copies the APK into the tracked `android/app/downloads/` directory and pushes that APK back to `main` after a successful build. It uploads the artifact (90-day retention) and attaches packages to the versioned GitHub Release.

To download the APK, open **Actions → latest successful JPTI Cross-Platform Builds run → JPTI-Android-APK**, or open **Releases → latest version**. The distribution folder is created by the workflow; for a local Gradle build, the standard signed APK path is `android/app/build/outputs/apk/release/app-release.apk`.


## Desktop update behaviour

Packaged desktop builds check GitHub Releases at startup and every six hours while running. If a newer version is available, JPTI offers to open the matching platform installer. The user approves the download and installation. This is a safe download-and-install prompt, not a silent background replacement.

macOS distribution outside a developer environment may require Apple Developer ID signing and notarization. Windows SmartScreen reputation may require code signing. Those certificates are not created by CI and must be supplied separately.

## Data and security

- Do not put exchange API keys, signing keys, passwords or private tokens in frontend files or Git history.
- SHA-256 files are provided for package integrity checks; verify them before installing.
- GitHub Actions artifacts are temporary (30-day retention); versioned release assets are the durable download location.

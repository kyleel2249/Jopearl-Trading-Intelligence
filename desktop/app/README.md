# JPTI Desktop Application

The Electron desktop application source lives in this directory.

- `main.cjs` — secure Electron main process, starts the local JPTI API runtime, serves the built React application, manages graceful shutdown and checks published releases.
- Renderer UI — shared JPTI application compiled into the root `dist/` directory.

## Build Windows executables

From the repository root:

```bash
npm install
npm run desktop:dist -- --publish never
```

The Windows workflow produces an NSIS installer and a portable Windows executable in `release/`. CI uploads the executable artifacts as `jpti-windows-desktop`.

The desktop runtime defaults to paper trading. Live order execution remains disabled. User data is stored in the operating system's Electron user-data directory, not inside the installation folder.

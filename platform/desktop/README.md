Desktop packaging notes

This folder contains a minimal Electron launcher that:

- Spawns the built backend from `backend/dist/index.js` (expects it to be built).
- Starts a small static server that serves `frontend/dist` and proxies `/api` and `/ws` to the backend.
- Opens an Electron BrowserWindow pointed at the static server.

Quick steps to run locally:

1. From the repository root, install deps and build frontend/backend:

```powershell
npm install
npm run build
```

2. Install desktop dependencies and start the Electron app:

```powershell
cd desktop
npm install
npm run start
```

Packaging:

- `npm run package` (from `desktop/`, or `npm run desktop:package` from the repo root) builds the production bundles and runs `electron-builder` for whichever OS it's invoked on, producing a platform-native installer via `desktop/package.js`:
  - Windows: NSIS `.exe` and, if the WiX Toolset (`candle.exe`/`light.exe`) is on `PATH`, an MSI via `electron-wix-msi`. Output lands in `desktop/installer` (MSI) and `desktop/dist` (NSIS).
  - macOS: `.dmg` and `.zip`, output in `desktop/dist`.
  - Linux: `.AppImage` and `.deb`, output in `desktop/dist`.
- The desktop installer bundles and runs the platform-specific helper in `desktop/extra/` to provision required CLI tools. In development mode, the helper scripts may also run on first launch.

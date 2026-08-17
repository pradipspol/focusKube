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

Packaging to MSI:

- This scaffolding includes `electron-wix-msi` as a devDependency in `desktop/package.json`. Building an MSI requires the WiX Toolset to be installed on the machine.
- A `package-windows.js` helper can be added to call electron-wix-msi to produce an MSI. You will need to provide an Electron build (e.g., via `electron-builder`) and then feed that into `electron-wix-msi`.

If you want, I can:
- Add an automated `package-windows.js` that invokes electron-builder then electron-wix-msi.
- Adjust the frontend to use an explicit `VITE_API_BASE` so no proxy is required.
- Add an option to run backend and static server in a single process (require backend app instead of spawning).

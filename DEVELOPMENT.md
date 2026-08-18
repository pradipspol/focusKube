

## Project Structure

- `backend/` - Express API, Kubernetes and Helm integration, auth/session handling, observability, and WebSocket support.
- `frontend/` - React + Vite UI with the main explorer experience.
- `desktop/` - Electron wrapper and Windows packaging support.
- `k8s/` - Kubernetes manifests and RBAC for deployment-related setup.

## Getting Started

### Prerequisites

- Node.js and npm
- Access to a Kubernetes cluster or saved kubeconfig
- Helm
- For Azure or AWS support, the relevant cloud credentials and CLI tools available in your environment

### Install dependencies

```bash
npm install
```

### Run the backend and frontend locally

In separate terminals:

```bash
npm run dev:backend
```

```bash
npm run dev:frontend
```

The backend listens on `http://localhost:4000` by default. The frontend runs on `http://localhost:5173`.

### Build the project

```bash
npm run build
```

### Type-check both apps

```bash
npm run typecheck
```

## Desktop App

The desktop wrapper is intended for Windows and bundles the Electron shell with the backend and frontend build output.

```bash
npm run desktop:start
```

To produce a packaged Windows installer:

```bash
npm run desktop:package
```

## Available Scripts

- `npm run dev:backend` - Start the backend in development mode.
- `npm run dev:frontend` - Start the Vite frontend.
- `npm run build` - Build backend and frontend.
- `npm run build:bundle:prod` - Build production bundles used by the desktop package flow.
- `npm run typecheck` - Type-check backend and frontend.
- `npm run desktop:start` - Launch Electron.
- `npm run desktop:package` - Build the Windows installer.

## Environment Variables

The backend reads the following environment variables:

- `PORT` - API port, default `4000`.
- `HOST` - API host, default `0.0.0.0`.
- `CORS_ORIGIN` - Allowed frontend origin, default `http://localhost:5173`.
- `KUBECONFIG` - Optional kubeconfig path.
- `ALLOW_SECRET_REVEAL` - Enable secret value display when set to `true`.
- `SESSION_STORAGE_DIR` - Session storage directory.
- `AZURE_CONFIG_SEED_DIR` - Optional seed directory for Azure config.
- `SESSION_TTL_HOURS` - Session lifetime, default `168`.
- `SLOW_REQUEST_WARN_MS` - Slow HTTP request threshold, default `5000`.
- `SLOW_COMMAND_WARN_MS` - Slow command threshold, default `5000`.
- `SLOW_K8S_WARN_MS` - Slow Kubernetes operation threshold, default `10000`.
- `K8S_API_TIMEOUT_MS` - Kubernetes API timeout, default `12000`.
- `K8S_LIST_TIMEOUT_MS` - Kubernetes list timeout, default `12000`.
- `K8S_CONTEXT_PROBE_TIMEOUT_MS` - Context probe timeout, default `5000`.
- `AZURE_AUTH_CHECK_TIMEOUT_MS` - Azure auth check timeout, default `5000`.
- `AZURE_AUTH_CHECK_CACHE_MS` - Azure auth cache window, default `15000`.
- `LOG_RETENTION_DAYS` - Log retention period, default `5`.
- `APP_BASE_URL` - Frontend base URL used for redirects, default `http://localhost:5173`.
- `DEFAULT_ADMIN_EMAIL` - Default local identity used by the desktop session, default `user@desktop.com`.
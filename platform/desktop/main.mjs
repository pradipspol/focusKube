import { app, BrowserWindow } from 'electron';
import path from 'path';
import { spawn } from 'child_process';
import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import getPort from 'get-port';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let backendProc = null;
let server = null;

async function startBackend() {
  const backendDir = path.resolve(__dirname, '..', 'backend');
  const entry = path.join(backendDir, 'dist', 'index.js');
  if (!fs.existsSync(entry)) {
    console.error('Backend build not found at', entry);
    throw new Error('Backend not built. Run `npm run build` at project root first.');
  }
  const env = Object.assign({}, process.env, {
    PORT: process.env.BACKEND_PORT || '4000',
    NODE_ENV: 'production',
    BACKEND_MODE: 'desktop',
  });
  
  console.log('Starting backend');
  console.log('Backend entry:', entry);
  console.log('Backend working directory:', backendDir);
  console.log('Backend port:', env.PORT);
  
  try {
    backendProc = spawn('node', [entry], {
      cwd: backendDir,
      env: { ...env, K8S_EXPLORER_RESOURCES_PATH: process.resourcesPath },
      stdio: 'ignore',
      windowsHide: true,
      detached: true,
    });
    try { backendProc.unref(); } catch (e) {}
  } catch (err) {
    throw new Error(`Failed to spawn backend: ${err.message}`);
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      resolve(Number(env.PORT) || 4000);
    }, 3000);
    backendProc.on('error', (err) => {
      clearTimeout(timeout);
      console.error('Backend spawn error:', err);
      reject(err);
    });
    backendProc.on('exit', (code, signal) => {
      clearTimeout(timeout);
      console.log('Backend exited with code:', code, 'signal:', signal);
    });
  });
}

async function startStaticServer(proxyTargetPort) {
  const app = express();
  const frontendDir = path.resolve(__dirname, '..', 'frontend', 'dist');
  if (!fs.existsSync(frontendDir)) {
    throw new Error('Frontend build not found at ' + frontendDir + '. Run `npm run build` at project root first.');
  }
  // Proxy /api to backend (use IPv4 loopback to avoid localhost IPv6 resolution issues)
  app.use('/api', createProxyMiddleware({ target: `http://127.0.0.1:${proxyTargetPort}`, changeOrigin: true }));
  const wsProxy = createProxyMiddleware({ target: `http://127.0.0.1:${proxyTargetPort}`, ws: true });
  app.use('/ws', wsProxy);
  // Serve static frontend files
  app.use(express.static(frontendDir));
  // Fallback to index.html
  app.use((req, res) => res.sendFile(path.join(frontendDir, 'index.html')));

  const port = await getPort({ port: getPort.makeRange(3000, 3100) });
  return new Promise((resolve) => {
    server = app.listen(port, () => {
      server.on('upgrade', wsProxy.upgrade);
      console.log('Static server listening on', port);
      resolve(port);
    });
  });
}

async function createWindow(url) {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: path.join(__dirname, 'assets/icons/app.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  win.webContents.on('crashed', () => {
    console.error('Window crashed');
  });
  win.webContents.on('unresponsive', () => {
    console.error('Window became unresponsive');
  });
  try {
    await win.loadURL(url);
  } catch (err) {
    console.error('Failed to load URL:', err);
    throw err;
  }
}

app.whenReady().then(async () => {
  try {
    // Start backend
    const backendPort = await (async () => {
      // honor BACKEND_PORT env if provided
      const fixed = process.env.BACKEND_PORT ? Number(process.env.BACKEND_PORT) : undefined;
      if (fixed) {
        // still spawn backend with that port
        return fixed;
      }
      return 4000;
    })();

    await startBackend();
    // Give backend time to start
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Start static server which proxies to backend
    const staticPort = await startStaticServer(backendPort);
    // Give server time to fully initialize
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    const url = `http://localhost:${staticPort}`;
    console.log('Loading URL:', url);
    await createWindow(url);
  } catch (err) {
    console.error('Failed to start desktop app:', err);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (backendProc) backendProc.kill();
  if (server) server.close();
});

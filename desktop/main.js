// CommonJS wrapper to dynamically import ESM main module
const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const getPort = require('get-port');
const fs = require('fs');

let backendProc = null;
let server = null;

/**
 * Verify that CLI tools (az, helm, kubectl, kubelogin) are available.
 * Tools are installed by install-extras.ps1 during the NSIS installer setup.
 * At startup we only log their availability — we do NOT re-run the installer.
 * In dev mode (no installer ran), we do run the script once so developers don't
 * need to install tools manually.
 */
async function ensureCliTools() {
  if (process.platform !== 'win32') {
    console.log('[tools] Skipping CLI tool check (not Windows)');
    return;
  }

  const isPackaged = app.isPackaged;

  if (isPackaged) {
    // In packaged mode tools should already be installed by the NSIS installer.
    // Verify using the augmented PATH (extras dir + wbin) so bundled .exe files
    // and az.cmd are visible — the system PATH alone won't include extras dir.
    const augmented = buildAugmentedPath(process.resourcesPath);
    const { execSync } = require('child_process');

    // Candidates: bundled exe names and az-specific .cmd variant
    const toolCandidates = {
      az:        ['az.cmd', 'az.exe', 'az'],
      helm:      ['helm.exe', 'helm'],
      kubelogin: ['kubelogin.exe', 'kubelogin'],
    };

    console.log('[tools] Verifying CLI tools via augmented PATH...');
    for (const [tool, candidates] of Object.entries(toolCandidates)) {
      let found = null;
      for (const candidate of candidates) {
        try {
          const out = execSync(`where ${candidate}`, {
            encoding: 'utf8',
            env: { ...process.env, PATH: augmented },
            stdio: ['ignore', 'pipe', 'ignore'],
          }).trim();
          found = out.split('\n')[0];
          break;
        } catch { /* try next candidate */ }
      }
      if (found) {
        console.log(`[tools] [OK] ${tool}: ${found}`);
      } else {
        console.warn(`[tools] [--] ${tool}: not found — NSIS hook may not have run`);
      }
    }
    return;
  }

  // Dev mode: run install script so developers don't need to set up tools manually.
  let extrasScript = path.join(__dirname, 'extra', 'install-extras.ps1');
  if (!fs.existsSync(extrasScript) && process.resourcesPath) {
    extrasScript = path.join(process.resourcesPath, 'extras', 'install-extras.ps1');
  }

  console.log('[tools] Dev mode: running install script at: ' + extrasScript);
  if (!fs.existsSync(extrasScript)) {
    console.log('[tools] Install script not found, skipping. Tried:');
    console.log('[tools]   - ' + path.join(__dirname, 'extra', 'install-extras.ps1'));
    return;
  }

  return new Promise((resolve) => {
    const proc = spawn('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', extrasScript,
      '-Action', 'install',
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    if (proc.stdout) {
      proc.stdout.on('data', (chunk) => console.log('[tools]', chunk.toString().trim()));
    }
    if (proc.stderr) {
      proc.stderr.on('data', (chunk) => console.warn('[tools] STDERR:', chunk.toString().trim()));
    }

    proc.on('close', (code) => {
      if (code === 0) {
        console.log('[tools] CLI tools ready.');
      } else {
        console.warn(`[tools] Install script exited with code ${code}. Tools may be missing.`);
      }
      resolve();
    });

    proc.on('error', (err) => {
      console.warn('[tools] Failed to run install script:', err.message);
      resolve();
    });
  });
}

/**
 * Build an augmented PATH that includes the bundled extras directory and the
 * WinGet links directory. This ensures that helm, kubectl, kubelogin (bundled
 * .exe files) and any tools installed by winget moments ago are immediately
 * runnable by the backend process even when the OS session PATH is stale.
 */
function buildAugmentedPath(resourcesPath) {
  const sep = process.platform === 'win32' ? ';' : ':';
  const extra = [];

  console.log('[path] Building augmented PATH...');
  console.log('[path] resourcesPath:', resourcesPath || 'undefined');
  console.log('[path] __dirname:', __dirname);

  // Bundled binaries location (helm.exe, kubectl.exe, kubelogin.exe)
  // Packaged: resources/extras (via extraResources in package.json)
  // Dev: desktop/extra
  const extrasDir = resourcesPath
    ? path.join(resourcesPath, 'extras')
    : path.join(__dirname, 'extra');
  
  console.log('[path] Checking extras dir:', extrasDir);
  if (fs.existsSync(extrasDir)) {
    extra.push(extrasDir);
    console.log('[path]   [OK] Exists, adding to PATH');
    try {
      const files = fs.readdirSync(extrasDir);
      console.log('[path]   Contents:', files.join(', '));
    } catch (e) {
      console.log('[path]   (Cannot read contents)');
    }
  } else {
    console.log('[path]   [--] Does not exist');
  }

  // WinGet places command aliases here; may be fresher than the inherited PATH
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const wingetLinks = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links');
    if (fs.existsSync(wingetLinks)) {
      extra.push(wingetLinks);
      console.log('[path] WinGet links dir added to PATH:', wingetLinks);
    }
  }

  // Azure kubelogin is installed by `az aks install-cli` into ~/.azure-kubelogin
  // This is the correct Azure-specific kubelogin (Azure/kubelogin), distinct from
  // the OIDC kubelogin (int128/kubelogin). Must be in PATH for AKS authentication.
  if (process.platform === 'win32' && process.env.USERPROFILE) {
    const azureKubeloginDir = path.join(process.env.USERPROFILE, '.azure-kubelogin');
    if (fs.existsSync(azureKubeloginDir)) {
      extra.push(azureKubeloginDir);
      console.log('[path] Azure kubelogin dir added to PATH:', azureKubeloginDir);
    }
  }

  // Azure CLI installs az.cmd into a wbin directory that may not be in the
  // inherited session PATH on a freshly provisioned machine.
  if (process.platform === 'win32') {
    console.log('[path] Checking for Azure CLI in standard locations...');
    const programRoots = [
      process.env['ProgramFiles(x86)'],
      process.env.ProgramFiles,
      'C:\\Program Files (x86)',
      'C:\\Program Files',
    ].filter(Boolean);
    for (const root of programRoots) {
      const wbin = path.join(root, 'Microsoft SDKs', 'Azure', 'CLI2', 'wbin');
      console.log('[path]   Checking:', wbin);
      if (fs.existsSync(wbin)) {
        extra.push(wbin);
        console.log('[path]   [OK] Found, adding to PATH');
        try {
          const files = fs.readdirSync(wbin);
          console.log('[path]   Contents:', files.slice(0, 5).join(', '), files.length > 5 ? '...' : '');
        } catch (e) {
          console.log('[path]   (Cannot read contents)');
        }
        break; // only need the first match
      } else {
        console.log('[path]   [--] Not found');
      }
    }
  }

  if (extra.length === 0) return process.env.PATH || '';
  
  const newPath = extra.join(sep) + sep + (process.env.PATH || '');
  console.log('[path] Final augmented PATH (first 5 entries):');
  newPath.split(sep).slice(0, 5).forEach(p => {
    if (p) console.log('[path]   -', p);
  });
  console.log('[path]   ... (', newPath.split(sep).length, 'total entries)');
  
  return newPath;
}

async function startBackend(backendPort) {
  const backendDir = path.resolve(__dirname, '..', 'k8x-be');
  const entry = path.join(backendDir, 'index.js');
  if (!fs.existsSync(entry)) {
    console.error('Backend build not found at', entry);
    throw new Error('Backend not built. Run `npm run build` at project root first.');
  }
  const augmentedPath = buildAugmentedPath(process.resourcesPath);
  const env = Object.assign({}, process.env, {
    PORT: backendPort,
    NODE_ENV: 'production',
    BACKEND_MODE: 'desktop',
    PATH: augmentedPath,
    LOG_LEVEL: process.env.K8S_LOG_LEVEL || 'error'
  });
  
  console.log('Starting backend');
  console.log('Backend entry:', entry);
  console.log('Backend working directory:', backendDir);
  console.log('Backend port:', env.PORT);
  
  try {
    // Write backend stdout/stderr to a log file so we can diagnose startup
    // failures (ECONNREFUSED) without opening visible consoles.
    const logDir = app.getPath('userData') || backendDir;
    const logFile = path.join(logDir, 'k8s-backend.log');
    try {
      fs.mkdirSync(logDir, { recursive: true });
    } catch (e) {
      /* ignore */
    }
    const outStream = fs.createWriteStream(logFile, { flags: 'a' });
    console.log('Backend log:', logFile);

    // Write a header so we can detect whether the log file is writable and
    // what path the app is using for logs.
    try {
      fs.appendFileSync(logFile, `\n=== k8-explorer backend log start: ${new Date().toISOString()} ===\n`);
    } catch (e) {
      console.error('Failed to write initial header to backend log:', e.message || e);
    }

    // Keep backend as a child of the Electron process so Windows won't create
    // a separate console for it. Do not detach; hide its window. Pipe stdio
    // and forward into the log file to capture errors.
    backendProc = spawn('node', [entry], {
      cwd: backendDir,
      env: { ...env, K8S_EXPLORER_RESOURCES_PATH: process.resourcesPath },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    if (backendProc.stdout) backendProc.stdout.pipe(outStream);
    if (backendProc.stderr) backendProc.stderr.pipe(outStream);
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
  const frontendDir = path.resolve(__dirname, '..', 'k8x-fe');
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

  const frontendPort = await getPort({ port: getPort.makeRange(11111, 48999) });
  return new Promise((resolve) => {
    server = app.listen(frontendPort, () => {
      server.on('upgrade', wsProxy.upgrade);
      console.log('Static server listening on', frontendPort);
      resolve(frontendPort);
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
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('Render process gone:', JSON.stringify(details));
  });
  win.webContents.on('unresponsive', () => {
    console.error('Window became unresponsive');
  });
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error('did-fail-load:', errorCode, errorDescription, validatedURL);
  });
  Menu.setApplicationMenu(null);
  try {
    await win.loadURL(url);
  } catch (err) {
    console.error('Failed to load URL:', err);
    throw err;
  }
}

app.whenReady().then(async () => {
  try {
    // First ensure CLI tools (az, helm, kubectl, kubelogin) are available
    await ensureCliTools();
    
    // Start backend
    const backendPort = await (async () => {
      // honor BACKEND_PORT env if provided
      const fixed = await getPort({ port: getPort.makeRange(11111, 48999) });
      if (fixed) {
        // still spawn backend with that port
        return fixed;
      }
      return 49000;
    })();

    await startBackend(backendPort);
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

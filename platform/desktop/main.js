// CommonJS wrapper to dynamically import ESM main module
const { app, BrowserWindow, Menu, ipcMain, shell, net, nativeTheme } = require('electron');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const getPort = require('get-port');
const fs = require('fs');

const GITHUB_REPOSITORY = 'pradipspol/focusKube';

async function fetchGithub(url, parseJson = false) {
  const response = await net.fetch(url, {
    headers: { 'User-Agent': 'focusKube-desktop' },
  });
  if (!response.ok) {
    throw new Error(`GitHub request failed with status ${response.status}`);
  }
  const body = await response.text();
  return parseJson ? JSON.parse(body) : body;
}

ipcMain.handle('open-external', async (_event, url) => {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') {
    throw new Error('Only approved HTTPS GitHub links can be opened.');
  }
  await shell.openExternal(parsed.toString());
});
ipcMain.handle('fetch-github-file', (_event, filePath) => {
  if (filePath !== 'LICENSE') throw new Error('Unsupported GitHub file.');
  return fetchGithub(`https://raw.githubusercontent.com/${GITHUB_REPOSITORY}/main/${filePath}`);
});
ipcMain.handle('fetch-latest-release', async () => {
  const releases = await fetchGithub(`https://api.github.com/repos/${GITHUB_REPOSITORY}/releases?per_page=20`, true);
  const release = releases.find((entry) => !entry.draft);
  if (!release) throw new Error('No published GitHub releases are available.');
  return { name: release.name || release.tag_name || 'Latest release', body: release.body || 'No release notes available.' };
});
ipcMain.handle('get-app-info', () => ({
  name: 'FocusKube',
  version: app.getVersion(),
  description: 'Kubernetes Explorer Desktop Client',
}));

// App background per theme, mirrored from the --bg token in index.css.
const THEME_BACKGROUNDS = {
  dark: '#0c1117',
  light: '#f7f9fb',
  contrast: '#000000',
};

ipcMain.handle('set-native-theme', (event, theme) => {
  const normalized = theme === 'light' ? 'light' : 'dark';
  nativeTheme.themeSource = normalized;
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    win.setBackgroundColor(THEME_BACKGROUNDS[theme] || THEME_BACKGROUNDS.dark);
  }
});

let backendProc = null;
let server = null;

function recoverableMainError(scope, err) {
  const message = err && err.stack ? err.stack : err && err.message ? err.message : String(err);
  console.error(`[main] Recoverable error in ${scope}:`, message);
}

process.on('uncaughtException', (err) => {
  recoverableMainError('uncaughtException', err);
});

process.on('unhandledRejection', (reason) => {
  recoverableMainError('unhandledRejection', reason);
});

// Outside the backend's dynamic port range (11111-48999) so it never collides
// with whatever port `startBackend` happens to pick.
const PREFERRED_FRONTEND_PORT = 49500;

/**
 * Locate an executable by walking an explicit PATH string, without shelling
 * out to `where`/`which` (keeps this working identically on every platform).
 */
function findOnAugmentedPath(candidate, augmentedPath) {
  const dirs = (augmentedPath || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const full = path.join(dir, candidate);
    try {
      if (fs.existsSync(full)) return full;
    } catch { /* ignore and keep searching */ }
  }
  return null;
}

/** Per-platform install-extras script + the command used to run it. */
function resolveExtrasRunner(extrasScript) {
  if (process.platform === 'win32') {
    return {
      cmd: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', extrasScript, '-Action', 'install'],
    };
  }
  return { cmd: process.platform === 'darwin' ? '/bin/bash' : 'bash', args: [extrasScript, 'install'] };
}

function runExtrasInstaller(extrasScript) {
  const { cmd, args } = resolveExtrasRunner(extrasScript);

  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
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
      resolve(code === 0);
    });

    proc.on('error', (err) => {
      console.warn('[tools] Failed to run install script:', err.message);
      resolve(false);
    });
  });
}

/**
 * Verify that CLI tools (az, helm, kubectl, kubelogin) are available.
 * Packaged applications provision them on first launch; development mode
 * runs the local helper script on every launch for convenience.
 */
async function ensureCliTools() {
  const isPackaged = app.isPackaged;

  if (isPackaged) {
    const scriptName = process.platform === 'win32' ? 'install-extras.ps1' : 'install-extras.sh';
    const bundledExtrasScript = path.join(process.resourcesPath, 'extras', scriptName);
    const extrasDir = app.getPath('userData');
    const extrasScript = path.join(extrasDir, scriptName);
    const markerPath = path.join(extrasDir, '.extras-installed');

    if (!fs.existsSync(markerPath)){
      if (!fs.existsSync(extrasScript) && fs.existsSync(bundledExtrasScript)) {
        try {
          fs.mkdirSync(extrasDir, { recursive: true });
          fs.copyFileSync(bundledExtrasScript, extrasScript);
          console.log('[tools] Copied install script to ' + extrasScript);
        } catch (err) {
          console.warn('[tools] Could not copy install script:', err.message);
        }
      }

      if (fs.existsSync(extrasScript)) {
        console.log('[tools] First launch: running install script at ' + extrasScript);
        if (await runExtrasInstaller(extrasScript)) {
          try {
            fs.writeFileSync(markerPath, new Date().toISOString(), 'utf8');
          } catch (err) {
            console.warn('[tools] Could not write install marker:', err.message);
          }
        }
      }
    }

    // Verify tools using the augmented PATH, which includes package-manager
    // and platform tool directories.
    const augmented = buildAugmentedPath(process.resourcesPath);

    const toolCandidates = process.platform === 'win32'
      ? { az: ['az.cmd', 'az.exe'], helm: ['helm.exe'], kubectl: ['kubectl.exe'], kubelogin: ['kubelogin.exe'] }
      : { az: ['az'], helm: ['helm'], kubectl: ['kubectl'], kubelogin: ['kubelogin'] };

    console.log('[tools] Verifying CLI tools via augmented PATH...');
    for (const [tool, candidates] of Object.entries(toolCandidates)) {
      const found = candidates.map((c) => findOnAugmentedPath(c, augmented)).find(Boolean);
      if (found) {
        console.log(`[tools] [OK] ${tool}: ${found}`);
      } else {
        console.warn(`[tools] [--] ${tool}: not found — installer helper may have failed`);
        await runExtrasInstaller(extrasScript);
      }
    }
    return;
  }

  // Dev mode: run install script so developers don't need to set up tools manually.
  const scriptName = process.platform === 'win32' ? 'install-extras.ps1' : 'install-extras.sh';
  let extrasScript = path.join(__dirname, 'extra', scriptName);
  if (!fs.existsSync(extrasScript) && process.resourcesPath) {
    extrasScript = path.join(process.resourcesPath, 'extras', scriptName);
  }

  console.log('[tools] Dev mode: running install script at: ' + extrasScript);
  if (!fs.existsSync(extrasScript)) {
    console.log('[tools] Install script not found, skipping. Tried:');
    console.log('[tools]   - ' + path.join(__dirname, 'extra', scriptName));
    return;
  }

  await runExtrasInstaller(extrasScript);
}

/**
 * Build an augmented PATH that includes package-manager and platform tool
 * directories, so recently installed tools are immediately runnable by the
 * backend process even when the OS session PATH is stale.
 */
function buildAugmentedPath(resourcesPath) {
  const sep = path.delimiter;
  const extra = [];

  console.log('[path] Building augmented PATH...');
  console.log('[path] resourcesPath:', resourcesPath || 'undefined');
  console.log('[path] __dirname:', __dirname);

  // WinGet places command aliases here; may be fresher than the inherited PATH
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const wingetLinks = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links');
    if (fs.existsSync(wingetLinks)) {
      extra.push(wingetLinks);
      console.log('[path] WinGet links dir added to PATH:', wingetLinks);
    }
  }

  // Azure kubelogin is installed by `az aks install-cli` into ~/.azure-kubelogin
  // on every platform. This is the correct Azure-specific kubelogin
  // (Azure/kubelogin), distinct from the OIDC kubelogin (int128/kubelogin).
  // Must be in PATH for AKS authentication.
  const azureKubeloginDir = path.join(os.homedir(), '.azure-kubelogin');
  if (fs.existsSync(azureKubeloginDir)) {
    extra.push(azureKubeloginDir);
    console.log('[path] Azure kubelogin dir added to PATH:', azureKubeloginDir);
  }

  if (process.platform === 'win32') {
    // Azure CLI installs az.cmd into a wbin directory that may not be in the
    // inherited session PATH on a freshly provisioned machine.
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
  } else {
    // Common Homebrew (macOS Apple Silicon/Intel) and Linux package manager
    // install locations that may be missing from a GUI-launched app's PATH.
    const unixDirs = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin'];
    for (const dir of unixDirs) {
      if (fs.existsSync(dir)) {
        extra.push(dir);
        console.log('[path] Added standard tool dir to PATH:', dir);
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
    const logFile = path.join(logDir, 'focusKube.log');
    try {
      fs.mkdirSync(logDir, { recursive: true });
    } catch (e) {
      /* ignore */
    }

    // Cap the log file size so a chatty backend (or a long-running session)
    // can never fill the disk. Once it crosses MAX_LOG_BYTES we rotate it
    // through up to MAX_LOG_BACKUPS numbered backups and start a fresh file.
    const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5 MB
    const MAX_LOG_BACKUPS = 5;
    let writtenBytes = 0;
    try {
      writtenBytes = fs.statSync(logFile).size;
    } catch (e) {
      /* file doesn't exist yet */
    }
    let outStream = fs.createWriteStream(logFile, { flags: 'a' });
    outStream.on('error', (err) => recoverableMainError('backend log stream', err));
    console.log('Backend log:', logFile);

    function rotateLogIfNeeded(nextChunkSize) {
      if (writtenBytes + nextChunkSize <= MAX_LOG_BYTES) return;
      outStream.end();
      try {
        // Shift logFile.4 -> .5, logFile.3 -> .4, ..., logFile -> .1, oldest dropped.
        try {
          fs.rmSync(`${logFile}.${MAX_LOG_BACKUPS}`, { force: true });
        } catch (e) {
          /* ignore */
        }
        for (let i = MAX_LOG_BACKUPS - 1; i >= 1; i--) {
          try {
            fs.renameSync(`${logFile}.${i}`, `${logFile}.${i + 1}`);
          } catch (e) {
            /* ignore missing intermediate backups */
          }
        }
        fs.renameSync(logFile, `${logFile}.1`);
      } catch (e) {
        /* ignore rotation failures; worst case we keep appending to the same file */
      }
      outStream = fs.createWriteStream(logFile, { flags: 'a' });
      outStream.on('error', (err) => recoverableMainError('backend rotated log stream', err));
      writtenBytes = 0;
    }

    function writeToLog(chunk) {
      try {
        rotateLogIfNeeded(chunk.length);
        outStream.write(chunk);
        writtenBytes += chunk.length;
      } catch (e) {
        /* ignore individual write failures so the backend keeps running */
      }
    }

    // Write a header so we can detect whether the log file is writable and
    // what path the app is using for logs.
    try {
      fs.appendFileSync(logFile, `\n=== focusKube backend log start: ${new Date().toISOString()} ===\n`);
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

    if (backendProc.stdout) backendProc.stdout.on('data', writeToLog);
    if (backendProc.stderr) backendProc.stderr.on('data', writeToLog);
  } catch (err) {
    recoverableMainError('backend startup', err);
  }

  return new Promise((resolve) => {
    let settled = false;
    const resolveOnce = () => {
      if (settled) return;
      settled = true;
      resolve(Number(env.PORT) || 4000);
    };
    const timeout = setTimeout(() => {
      resolveOnce();
    }, 3000);
    if (!backendProc) {
      clearTimeout(timeout);
      resolveOnce();
      return;
    }
    backendProc.on('error', (err) => {
      clearTimeout(timeout);
      recoverableMainError('backend process', err);
      resolveOnce();
    });
    backendProc.on('exit', (code, signal) => {
      clearTimeout(timeout);
      console.log('Backend exited with code:', code, 'signal:', signal);
      resolveOnce();
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

  // Prefer a fixed port so the window's origin (and thus localStorage-backed
  // state like starred contexts and sidebar layout) stays the same across app
  // restarts. Only fall back to scanning a range if that port is unavailable
  // (e.g. another local process already holds it).
  const frontendPort = await getPort({ port: [PREFERRED_FRONTEND_PORT, ...getPort.makeRange(11111, 48999)] });
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
    icon: path.join(__dirname, 'assets/icons/app_150.png'),
    frame: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  // set background color of windows as frame color; updated per-theme via set-native-theme
  win.setBackgroundColor('#0c1117');
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
  const menu = Menu.buildFromTemplate([
    {
      label: '',
      enabled: false
    },
    {
      label: 'File',
      submenu: [
        { label: 'Preferences', click: () => win.webContents.send('desktop-menu-action', 'preferences') },
        { role: 'quit', label: 'Exit' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Documents', click: () => shell.openExternal(`https://github.com/${GITHUB_REPOSITORY}#readme`) },
        { label: 'Release Notes', click: () => win.webContents.send('desktop-menu-action', 'release-notes') },
        { type: 'separator' },
        { label: 'Toggle Developer Tools', accelerator: 'F12', click: () => win.webContents.toggleDevTools() },
        { type: 'separator' },
        { label: 'License', click: () => win.webContents.send('desktop-menu-action', 'license') },
        { label: 'About', click: () => win.webContents.send('desktop-menu-action', 'about') },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
  try {
    await win.loadURL(url);
  } catch (err) {
    console.error('Failed to load URL:', err);
    throw err;
  }
}

async function createStartupErrorWindow(err) {
  const win = new BrowserWindow({
    width: 900,
    height: 620,
    icon: path.join(__dirname, 'assets/icons/app_150.png'),
    frame: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  win.setBackgroundColor('#0c1117');
  const message = err && err.message ? err.message : String(err);
  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>FocusKube</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0c1117; color: #e8edf2; font: 16px/1.5 sans-serif; }
    main { width: min(680px, calc(100vw - 48px)); }
    h1 { margin: 0 0 12px; font-size: 24px; }
    pre { white-space: pre-wrap; padding: 16px; background: #151d27; border-radius: 8px; overflow-wrap: anywhere; }
  </style>
</head>
<body><main><h1>FocusKube could not finish startup</h1><pre>${escapeHtml(message)}</pre></main></body>
</html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
    recoverableMainError('desktop startup', err);
    await createStartupErrorWindow(err);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (backendProc) backendProc.kill();
  if (server) server.close();
});

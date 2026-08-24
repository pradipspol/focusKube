const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

function ensureMsiIconFile() {
  const iconPath = path.join(__dirname, 'assets', 'icons', 'app512.ico');
  if (!fs.existsSync(iconPath)) {
    throw new Error(`MSI icon not found at ${iconPath}`);
  }
  return iconPath;
}

function buildBundles(rootDir) {
  console.log('Building backend and frontend bundles for desktop packaging...');
  execSync('npm run build:bundle:prod', {
    stdio: 'inherit',
    cwd: rootDir,
    env: { ...process.env, K8_EXPLORER_DESKTOP: 'true' },
  });
}

async function packageWindows(desktopDir) {
  console.log('Building Electron app with electron-builder (Windows)...');
  try {
    execSync('npx electron-builder --win --x64', { stdio: 'inherit', cwd: desktopDir });
  } catch (err) {
    console.error('electron-builder failed. Ensure dependencies are installed.');
    process.exit(1);
  }

  // electron-builder outputs in desktop/dist or top-level dist; search for win-unpacked
  const winUnpacked = path.join(desktopDir, 'dist', 'win-unpacked');
  if (!fs.existsSync(winUnpacked)) {
    console.error('Could not find win-unpacked in', winUnpacked);
    process.exit(1);
  }

  const appExe = fs.readdirSync(winUnpacked).find(f => f.endsWith('.exe')) || 'app.exe';
  const exeName = appExe;

  const msiOutputDir = path.join(desktopDir, 'installer');
  if (!fs.existsSync(msiOutputDir)) fs.mkdirSync(msiOutputDir);

  // Always copy the NSIS .exe installer out of dist/ alongside the MSI, so
  // both artifacts end up in desktop/installer regardless of whether WiX is
  // available to build the MSI below.
  const nsisExeFile = fs
    .readdirSync(path.join(desktopDir, 'dist'))
    .filter(f => f.endsWith('.exe'))
    .find(f => f.includes('-Setup-')) || null;
  if (nsisExeFile) {
    fs.copyFileSync(path.join(desktopDir, 'dist', nsisExeFile), path.join(msiOutputDir, nsisExeFile));
    console.log('Copied NSIS installer to', path.join(msiOutputDir, nsisExeFile));
  } else {
    console.error('No NSIS .exe installer found in', path.join(desktopDir, 'dist'));
    process.exit(1);
  }

  console.log('Creating MSI with electron-wix-msi...');
  // WiX's ProductVersion must be a plain numeric dotted version; strip any
  // semver pre-release/build suffix (e.g. "0.1.0-1" -> "0.1.0").
  const msiVersion = require('./package.json').version.split('-')[0];
  const { MSICreator } = require('electron-wix-msi');
  const creator = new MSICreator({
    appDirectory: winUnpacked,
    outputDirectory: msiOutputDir,
    exe: exeName,
    name: 'focusKube',
    manufacturer: 'FocusKube',
    version: msiVersion,
    description: 'Kubernetes Cluster Explorer & Operations Console',
    appIconPath: ensureMsiIconFile(),
    ui: {
      chooseDirectory: true
    }
  });

  // Create a .wxs template
  await creator.create();
  // If a post-install script was bundled, patch the generated .wxs to run it during MSI install and during uninstall.
  const installScriptPath = path.join(winUnpacked, 'extras', 'install-extras.ps1');
  if (fs.existsSync(installScriptPath)) {
      console.log('post-install script found; patching .wxs to run it before install finalization and during uninstall');
    const wxsFiles = (fs.readdirSync(msiOutputDir) || []).filter(f => f.endsWith('.wxs'));
    if (wxsFiles.length) {
      const wxsFile = path.join(msiOutputDir, wxsFiles[0]);
      let content = fs.readFileSync(wxsFile, 'utf8');
      // Insert WixUtilExtension namespace if missing
      if (!content.includes('WixUtilExtension')) {
        content = content.replace(/<Wix([^>]*)>/, '<Wix$1 xmlns:util="http://schemas.microsoft.com/wix/UtilExtension">');
      }
      // Add CustomActions to execute PowerShell against the bundled script for install and uninstall.
        const customActionSnippet = `\n  <!-- Custom actions to run bundled extra-tools script during install and uninstall -->\n  <CustomAction Id=\"RunPostInstallScript\" Execute=\"deferred\" Return=\"check\" Impersonate=\"no\" ExeCommand=\"[SystemFolder]WindowsPowerShell\\v1.0\\powershell.exe -ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File &quot;[INSTALLDIR]extras\\install-extras.ps1&quot;\" />\n  <CustomAction Id=\"RunUninstallScript\" Execute=\"deferred\" Return=\"ignore\" Impersonate=\"no\" ExeCommand=\"[SystemFolder]WindowsPowerShell\\v1.0\\powershell.exe -ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File &quot;[INSTALLDIR]extras\\install-extras.ps1&quot; -Action uninstall\" />\n`;
      // Inject into the Product element (after the opening <Product ...>)
      content = content.replace(/(<Product[\s\S]*?>)/, `$1${customActionSnippet}`);
      // Schedule the custom actions: run post-install after InstallFiles, and run uninstall before RemoveFiles when removing all.
      if (content.includes('</InstallExecuteSequence>')) {
            content = content.replace(/(<\/InstallExecuteSequence>)/, '  <Custom Action="RunPostInstallScript" Before="InstallFinalize" />\n  <Custom Action="RunUninstallScript" Before="RemoveFiles">REMOVE="ALL"</Custom>\n$1');
      } else {
        // Fallback: append a minimal InstallExecuteSequence with our custom actions
          const seq = '\n  <InstallExecuteSequence>\n    <Custom Action="RunPostInstallScript" Before="InstallFinalize" />\n    <Custom Action="RunUninstallScript" Before="RemoveFiles">REMOVE="ALL"</Custom>\n  </InstallExecuteSequence>\n';
        content = content.replace(/(<\/Product>)/, `${seq}$1`);
      }
      fs.writeFileSync(wxsFile, content, 'utf8');
      console.log('Patched', wxsFile);
    } else {
      console.warn('No .wxs file found to patch for post-install script');
    }
  }
  // Compile the template to a .msi
  // Ensure WiX toolset is installed (candle.exe and light.exe) before compiling
  function exeExistsInPath(exeName) {
    const paths = (process.env.PATH || '').split(path.delimiter);
    for (const p of paths) {
      const candidate = path.join(p, exeName);
      if (fs.existsSync(candidate)) return true;
    }
    return false;
  }

  if (exeExistsInPath('candle.exe') && exeExistsInPath('light.exe')) {
    await creator.compile();
    console.log('MSI created in', msiOutputDir);
    return;
  }

  console.warn('WiX toolset (candle.exe/light.exe) not found in PATH — MSI was not built.');
  console.warn('The NSIS .exe installer is still available in', msiOutputDir);
  console.warn('To also get an MSI, install WiX Toolset (v3.11+): https://wixtoolset.org/releases/');
}

function packageMac(desktopDir) {
  console.log('Building Electron app with electron-builder (macOS)...');
  try {
    execSync('npx electron-builder --mac', { stdio: 'inherit', cwd: desktopDir });
  } catch (err) {
    console.error('electron-builder failed. Ensure dependencies are installed.');
    process.exit(1);
  }
  console.log('macOS package(s) (.dmg/.zip) are available in', path.join(desktopDir, 'dist'));
}

function packageLinux(desktopDir) {
  console.log('Building Electron app with electron-builder (Linux)...');
  try {
    execSync('npx electron-builder --linux', { stdio: 'inherit', cwd: desktopDir });
  } catch (err) {
    console.error('electron-builder failed. Ensure dependencies are installed.');
    process.exit(1);
  }
  console.log('Linux package(s) (.AppImage/.deb) are available in', path.join(desktopDir, 'dist'));
}

async function run() {
  const desktopDir = __dirname;
  const rootDir = path.resolve(desktopDir, '..');

  buildBundles(rootDir);

  if (process.platform === 'win32') {
    await packageWindows(desktopDir);
  } else if (process.platform === 'darwin') {
    packageMac(desktopDir);
  } else {
    packageLinux(desktopDir);
  }
}

run().catch(err => { console.error(err); process.exit(1); });

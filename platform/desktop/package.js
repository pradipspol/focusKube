const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// electron-wix-msi injects these strings straight into the generated .wxs, so
// unescaped XML characters (e.g. "&") make candle.exe fail with CNDL0104.
function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function ensureMsiIconFile() {
  const iconPath = path.join(__dirname, 'assets', 'icons', 'app512.ico');
  if (!fs.existsSync(iconPath)) {
    throw new Error(`MSI icon not found at ${iconPath}`);
  }
  return iconPath;
}

// Recursively sums file sizes so we can populate the MSI's EstimatedSize
// registry value, which is what Windows uses to show "Size" in Add/Remove Programs.
function getDirectorySizeBytes(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    total += entry.isDirectory() ? getDirectorySizeBytes(entryPath) : fs.statSync(entryPath).size;
  }
  return total;
}

// Must stay constant across releases: Windows Installer only recognizes a new
// build as an upgrade of a previous one (rather than an unrelated product) when
// the UpgradeCode matches. electron-wix-msi generates a random one per build
// unless we pin it, which is why reinstalling created a duplicate Add/Remove
// Programs entry instead of replacing the existing one.
const FOCUSKUBE_MSI_UPGRADE_CODE = '22b82725-437c-4f94-91b3-29821ebc680d';

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
    name: escapeXml('FocusKube'),
    manufacturer: escapeXml('MorrowSys'),
    version: msiVersion,
    description: escapeXml('Kubernetes Cluster Explorer & Operations Console'),
    // NOTE: the option is `icon`, not `appIconPath` - the previous key was a
    // no-op, so the MSI's stub exe/shortcuts fell back to an icon extracted
    // from the packaged exe instead of our app icon.
    icon: ensureMsiIconFile(),
    upgradeCode: FOCUSKUBE_MSI_UPGRADE_CODE,
    ui: {
      chooseDirectory: true
    }
  });

  // Keep the MSI limited to installing the application files. Microsoft
  // silent validation runs MSI actions in a noninteractive service context;
  // prerequisite provisioning belongs in the NSIS/bootstrapper installer.
  const { wxsFile, wxsContent } = await creator.create();

  // electron-wix-msi doesn't set an EstimatedSize, so Add/Remove Programs
  // shows no size for the app. Inject it into the existing DisplayIcon
  // registry component (a component may have several RegistryValues as long
  // as only one carries KeyPath="yes").
  const estimatedSizeKb = Math.round(getDirectorySizeBytes(winUnpacked) / 1024);
  let patchedWxs = wxsContent.replace(
    /(<RegistryValue Name="DisplayIcon"[^>]*\/>)/,
    `$1\n              <RegistryValue Name="EstimatedSize" Type="integer" Value="${estimatedSizeKb}"/>`,
  );

  // electron-wix-msi's template appends "(Machine)"/"(User)" to the product
  // name to distinguish per-machine vs per-user installs in Add/Remove
  // Programs. We don't rely on that distinction, and it just confuses users,
  // so show a plain "FocusKube" regardless of install scope.
  patchedWxs = patchedWxs
    .replace(/FocusKube \(Machine\)/g, 'FocusKube')
    .replace(/FocusKube \(User\)/g, 'FocusKube');

  fs.writeFileSync(wxsFile, patchedWxs);
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
    const packageVersion = require('./package.json').version;
    const desiredMsiName = `FocusKube-Setup-${packageVersion}.msi`;
    const generatedMsi = fs
      .readdirSync(msiOutputDir)
      .filter(file => file.endsWith('.msi'))
      .find(file => file !== desiredMsiName);

    if (generatedMsi) {
      fs.renameSync(
        path.join(msiOutputDir, generatedMsi),
        path.join(msiOutputDir, desiredMsiName),
      );
    }

    console.log('MSI created in', path.join(msiOutputDir, desiredMsiName));
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

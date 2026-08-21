const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { MSICreator } = require('electron-wix-msi');

function ensureMsiIconFile() {
  const iconDir = path.join(os.tmpdir(), 'k8-explorer-msi');
  const iconPath = path.join(iconDir, 'app.ico');
  if (fs.existsSync(iconPath)) {
    return iconPath;
  }

  fs.mkdirSync(iconDir, { recursive: true });

  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z/C/HgAGgwJ/lQm8WQAAAABJRU5ErkJggg==';
  const pngBuffer = Buffer.from(pngBase64, 'base64');
  const iconBuffer = Buffer.alloc(6 + 16 + pngBuffer.length);

  iconBuffer.writeUInt16LE(0, 0);
  iconBuffer.writeUInt16LE(1, 2);
  iconBuffer.writeUInt16LE(1, 4);
  iconBuffer.writeUInt8(1, 6);
  iconBuffer.writeUInt8(1, 7);
  iconBuffer.writeUInt8(0, 8);
  iconBuffer.writeUInt8(0, 9);
  iconBuffer.writeUInt16LE(1, 10);
  iconBuffer.writeUInt16LE(32, 12);
  iconBuffer.writeUInt32LE(pngBuffer.length, 14);
  iconBuffer.writeUInt32LE(22, 18);
  pngBuffer.copy(iconBuffer, 22);

  fs.writeFileSync(iconPath, iconBuffer);
  return iconPath;
}

async function run() {
  const root = path.resolve(__dirname, '..');
  const desktopDir = __dirname;

  console.log('Building Electron app with electron-builder...');
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

  console.log('Creating MSI with electron-wix-msi...');
  const creator = new MSICreator({
    appDirectory: winUnpacked,
    outputDirectory: msiOutputDir,
    exe: exeName,
    name: 'k8-explorer',
    manufacturer: 'k8-explorer',
    version: '0.1.0',
    description: 'Kubernetes Explorer packaged as desktop app',
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

  if (exeExistsInPath('candle.exe') || exeExistsInPath('light.exe')){
      await creator.compile();
      console.log('MSI created in', msiOutputDir);
  }

  if (!exeExistsInPath('candle.exe') || !exeExistsInPath('light.exe') || true) {
    console.warn('WiX toolset not found in PATH. Attempting fallback to NSIS artifact if present.');
    // Try to find an NSIS installer produced by electron-builder in the dist folder
    const distFiles = (fs.readdirSync(path.join(desktopDir, 'dist')) || []).filter(f => f.endsWith('.exe'));
    if (distFiles.length) {
      const nsisExe = distFiles.find(f => f.includes('-Setup-')) || distFiles[0];
      const src = path.join(desktopDir, 'dist', nsisExe);
      const dest = path.join(msiOutputDir, nsisExe);
      try {
        fs.copyFileSync(src, dest);
        console.log('WiX not installed — copied NSIS installer to', dest);
        console.log('MSI step skipped. To produce an MSI, install WiX Toolset: https://wixtoolset.org/releases/');
        process.exit(0);
      } catch (err) {
        console.error('Failed to copy NSIS installer as fallback:', err);
        console.error('Please install WiX (v3.11+) and ensure candle.exe and light.exe are on your PATH.');
        process.exit(1);
      }
    }

    console.error('WiX toolset not found in PATH and no NSIS installer was found in dist.');
    console.error('Please install WiX (v3.11+) and ensure candle.exe and light.exe are on your PATH: https://wixtoolset.org/releases/');
    process.exit(1);
  }

  
}

run().catch(err => { console.error(err); process.exit(1); });

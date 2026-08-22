const fs = require('fs');
const path = require('path');

function copyRecursiveSync(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const item of fs.readdirSync(src)) {
      copyRecursiveSync(path.join(src, item), path.join(dest, item));
    }
    return;
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

module.exports = async function afterPack(context) {
  const projectRoot = path.resolve(context.packager.projectDir, '..');
  const resourceRoot = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');
  const backendSource = path.join(projectRoot, 'backend', 'dist');
  const frontendSource = path.join(projectRoot, 'frontend', 'dist');

  if (!fs.existsSync(backendSource)) {
    throw new Error(`Backend build not found at ${backendSource}. Run npm run build:bundle:prod before packaging.`);
  }

  if (!fs.existsSync(frontendSource)) {
    throw new Error(`Frontend build not found at ${frontendSource}. Run npm run build:bundle:prod before packaging.`);
  }

  copyRecursiveSync(backendSource, path.join(resourceRoot, 'k8x-be'));
  copyRecursiveSync(frontendSource, path.join(resourceRoot, 'k8x-fe'));
};
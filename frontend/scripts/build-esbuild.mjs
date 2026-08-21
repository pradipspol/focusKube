import { build } from 'esbuild';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendRoot = path.resolve(__dirname, '..');
const distDir = path.join(frontendRoot, 'dist');

await rm(distDir, { recursive: true, force: true });
await mkdir(path.join(distDir, 'assets'), { recursive: true });

// Shared esbuild options
const sharedOptions = {
  bundle: true,
  splitting: false,
  format: 'esm',
  platform: 'browser',
  target: ['es2022', 'chrome109', 'edge109'],
  jsx: 'automatic',
  sourcemap: false,
  minify: true,
  legalComments: 'none',
  loader: {
    '.css': 'css',
    '.svg': 'file',
    '.png': 'file',
    '.jpg': 'file',
    '.jpeg': 'file',
    '.gif': 'file',
    '.webp': 'file',
    '.ttf': 'file',
    '.woff': 'file',
    '.woff2': 'file',
  },
  define: {
    'process.env.NODE_ENV': '"production"',
    'import.meta.env': JSON.stringify({ MODE: 'production', PROD: true, DEV: false, SSR: false }),
    'import.meta.env.MODE': '"production"',
    'import.meta.env.PROD': 'true',
    'import.meta.env.DEV': 'false',
    'import.meta.env.SSR': 'false',
    'import.meta.env.K8_EXPLORER_DESKTOP': JSON.stringify(process.env.K8_EXPLORER_DESKTOP === 'true' ? 'true' : 'false'),
  },
  assetNames: 'assets/asset-[hash]',
  logLevel: 'info',
};

await build({
  ...sharedOptions,
  entryPoints: [path.join(frontendRoot, 'src', 'main.tsx')],
  outfile: path.join(distDir, 'assets', 'main.js'),
});

// Build web workers as separate files so the browser can load them via
// `new Worker(new URL(...))` — they must be standalone JS modules.
await build({
  ...sharedOptions,
  entryPoints: [
    path.join(frontendRoot, 'src', 'workers', 'watch.worker.ts'),
    path.join(frontendRoot, 'src', 'workers', 'metrics.worker.ts'),
  ],
  outdir: path.join(distDir, 'workers'),
  // Workers must not use CSS loader since they run in a Worker context
  loader: { ...sharedOptions.loader, '.css': 'empty' },
});

const htmlTemplate = await readFile(path.join(frontendRoot, 'index.html'), 'utf8');
const htmlOutput = htmlTemplate.replace(
  /<script type="module" src="\/src\/main\.tsx"><\/script>/,
  '<link rel="stylesheet" href="/assets/main.css" />\n    <script type="module" src="/assets/main.js"></script>'
);

await writeFile(path.join(distDir, 'index.html'), htmlOutput, 'utf8');

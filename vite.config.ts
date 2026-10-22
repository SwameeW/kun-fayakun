import { copyFileSync, createReadStream, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const root = dirname(fileURLToPath(import.meta.url));

/** Frozen data files served at runtime from <base>/data/. Nothing else in data/ ships. */
const RUNTIME_DATA = ['quran.json', 'hadith.json', 'constants.json', 'sources.json'] as const;

/** three.js Basis transcoder, needed by KTX2Loader on both backends. */
const BASIS_DIR = resolve(root, 'node_modules/three/examples/jsm/libs/basis');
const BASIS_FILES = ['basis_transcoder.js', 'basis_transcoder.wasm'] as const;

/**
 * Serves data/*.json and the Basis transcoder in dev, and copies them into
 * dist/ on build, so the app can fetch them relative to its base URL.
 */
function runtimeFiles(): Plugin {
  const routes = new Map<string, string>([
    ...RUNTIME_DATA.map((f) => [`/data/${f}`, resolve(root, 'data', f)] as const),
    ...BASIS_FILES.map((f) => [`/assets/basis/${f}`, join(BASIS_DIR, f)] as const),
  ]);
  let outDir = resolve(root, 'dist');
  return {
    name: 'kf-runtime-files',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0] ?? '';
        const file = routes.get(path);
        if (!file || !existsSync(file)) {
          next();
          return;
        }
        res.setHeader(
          'Content-Type',
          file.endsWith('.wasm') ? 'application/wasm' : file.endsWith('.js') ? 'text/javascript' : 'application/json',
        );
        createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      for (const [route, file] of routes) {
        if (!existsSync(file)) throw new Error(`Missing runtime file ${file}`);
        const dest = join(outDir, route);
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(file, dest);
      }
    },
  };
}

export default defineConfig({
  // Relative base so the build works from any path (static hosts, artifact hosting).
  base: './',
  plugins: [runtimeFiles()],
  build: {
    target: 'es2022',
    sourcemap: true,
    // Read by scripts/check-bundle.ts to measure the shell + Chapter 0 budget.
    manifest: true,
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 1500,
  },
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
});

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/** Generate dist/sw.js with a precache list of every emitted file. */
function serviceWorker(): Plugin {
  let outDir = 'dist';
  return {
    name: 'sumi-sw',
    apply: 'build',
    configResolved(c) {
      outDir = c.build.outDir;
    },
    closeBundle() {
      const files: string[] = [];
      const walk = (d: string) => {
        for (const n of readdirSync(d)) {
          const p = join(d, n);
          if (statSync(p).isDirectory()) walk(p);
          else files.push(relative(outDir, p).split(sep).join('/'));
        }
      };
      walk(outDir);
      const list = files.filter((f) => f !== 'sw.js' && !f.endsWith('.map') && !f.includes('LICENSE')).sort();
      const hash = createHash('sha256');
      for (const f of list) hash.update(f).update(readFileSync(join(outDir, f)));
      const version = hash.digest('hex').slice(0, 12);
      const precache = ['./', ...list.map((f) => './' + f)];
      const tpl = readFileSync(join(__dirname, 'sw', 'sw.template.js'), 'utf8');
      writeFileSync(join(outDir, 'sw.js'), tpl.replace('__VERSION__', version).replace('__PRECACHE__', JSON.stringify(precache)));
      writeFileSync(join(outDir, 'version.json'), JSON.stringify({ version, built: new Date().toISOString() }));
    },
  };
}

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2500,
  },
  plugins: [serviceWorker()],
  server: { host: true },
  preview: { host: true },
});

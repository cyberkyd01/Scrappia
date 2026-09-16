/**
 * Links local packages into node_modules so `@scrappia/*` imports resolve at runtime.
 * Uses a junction/symlink when the filesystem supports it, otherwise writes a stub package
 * whose `main`/`types` point back at the source package (needed on exFAT/FAT drives).
 */
import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync, rmSync, lstatSync, symlinkSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const groups = ['packages', 'apps'];
const nm = join(root, 'node_modules');
mkdirSync(nm, { recursive: true });

const toPosix = (p) => p.replace(/\\/g, '/');

for (const g of groups) {
  const dir = join(root, g);
  if (!existsSync(dir)) continue;
  for (const entry of readdirSync(dir)) {
    const pkgDir = join(dir, entry);
    const pj = join(pkgDir, 'package.json');
    if (!existsSync(pj)) continue;
    const pkg = JSON.parse(readFileSync(pj, 'utf8'));
    if (!pkg.name) continue;
    const target = join(nm, ...pkg.name.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    if (existsSync(target)) {
      const st = lstatSync(target);
      if (st.isSymbolicLink()) continue; // already linked
      rmSync(target, { recursive: true, force: true });
    }
    try {
      symlinkSync(pkgDir, target, 'junction');
      console.log(`linked ${pkg.name} -> ${toPosix(relative(root, pkgDir))} (junction)`);
    } catch {
      mkdirSync(target, { recursive: true });
      const rel = (p) => toPosix(relative(target, join(pkgDir, p)));
      const stub = {
        name: pkg.name,
        version: pkg.version ?? '0.0.0',
        type: 'module',
        main: rel(pkg.main ?? 'dist/index.js'),
        types: rel(pkg.types ?? 'dist/index.d.ts'),
        bin: pkg.bin ? Object.fromEntries(Object.entries(pkg.bin).map(([k, v]) => [k, rel(v)])) : undefined,
        scrappiaStub: true,
      };
      if (pkg.exports) {
        // `exports` targets cannot escape the package root, so subpaths become re-export stub files.
        for (const sp of Object.keys(pkg.exports).filter((k) => k !== '.')) {
          const t = pkg.exports[sp];
          const targetFile = typeof t === 'string' ? t : t.import;
          const stubFile = join(target, sp.replace(/^\.\//, '') + '.js');
          mkdirSync(dirname(stubFile), { recursive: true });
          writeFileSync(stubFile, `export * from '${rel(targetFile)}';\n`);
        }
      }
      writeFileSync(join(target, 'package.json'), JSON.stringify(stub, null, 2));
      console.log(`stubbed ${pkg.name} -> ${toPosix(relative(root, pkgDir))} (no symlink support)`);
    }
  }
}

// Runs an npm script in every package/app that defines it (replacement for `npm run --workspaces` on exFAT).
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const script = process.argv[2];
const order = ['packages/core', 'packages/inspector', 'packages/mcp', 'apps/cli', 'apps/server', 'apps/desktop'];
const extra = [];
for (const g of ['packages', 'apps']) if (existsSync(join(root, g))) for (const e of readdirSync(join(root, g))) { const p = `${g}/${e}`; if (!order.includes(p)) extra.push(p); }
let failed = false;
for (const p of [...order, ...extra]) {
  const pj = join(root, p, 'package.json');
  if (!existsSync(pj)) continue;
  const pkg = JSON.parse(readFileSync(pj, 'utf8'));
  if (!pkg.scripts?.[script]) continue;
  console.log(`\n=== ${pkg.name}: ${script} ===`);
  // run inside the package dir (not --prefix) so paths containing spaces work on Windows
  const r = spawnSync('npm', ['run', script], { cwd: join(root, p), stdio: 'inherit', shell: true, env: { ...process.env, PATH: `${join(root, 'node_modules', '.bin')}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}` } });
  if (r.status !== 0) { failed = true; console.error(`${pkg.name}: ${script} failed`); if (script === 'build') break; }
}
process.exit(failed ? 1 : 0);

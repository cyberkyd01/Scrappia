import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { CliError } from '../context.js';
import { json, table } from '../ui.js';

/** Read a secret from stdin: masked prompt on a TTY, otherwise the whole piped input. */
export async function readSecretInput(ctx: CliContext, prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!ctx.io.stdinTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  }
  ctx.err(prompt);
  return new Promise<string>((resolve, reject) => {
    let value = '';
    const wasRaw = stdin.isRaw;
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const finish = (err?: Error) => {
      stdin.off('data', onData);
      stdin.setRawMode?.(wasRaw ?? false);
      stdin.pause();
      ctx.err('\n');
      if (err) reject(err); else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '') return finish(new CliError('aborted', 130));
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '' || ch === '\b') { if (value) { value = value.slice(0, -1); ctx.err('\b \b'); } continue; }
        if (ch < ' ') continue;
        value += ch; ctx.err('*');
      }
    };
    stdin.on('data', onData);
  });
}

export function registerSecretCommands(program: Command, ctx: () => CliContext) {
  const secrets = program.command('secrets').description('Named secrets referenced by recipes and AI providers (API keys, proxy lists, SMTP config, DB connection strings)')
    .addHelpText('after', `
Recipes never embed secrets: sinks/alerts use "connectionRef"/"secretRef" names, AI providers use
--api-key-ref, proxies use engine.proxy.pool. Values are stored in the local data directory and
can also be provided as environment variables of the same name.

Examples:
  scrappia secrets set ANTHROPIC_API_KEY              (prompts, input masked)
  echo "postgres://..." | scrappia secrets set PG_MAIN
  scrappia secrets set SLACK_WEBHOOK https://hooks.slack.com/...`);

  secrets.command('set').description('Store a secret; reads the value from stdin/prompt when omitted')
    .argument('<name>')
    .argument('[value]')
    .action(async (name: string, value: string | undefined) => {
      const c = ctx();
      if (!/^[\w.-]+$/.test(name)) throw new CliError('secret names may contain letters, digits, "_", "." and "-"');
      const v = value ?? (await readSecretInput(c, `value for ${name}: `));
      if (!v) throw new CliError('empty value; nothing stored');
      c.app.setSecret(name, v);
      c.ok(`stored secret ${name} (${v.length} chars)`);
    });

  secrets.command('list').description('List secret names (values are never printed)').option('--json').action((opts: { json?: boolean }) => {
    const c = ctx();
    const names = c.app.storage.listSecretNames();
    if (opts.json) { c.out(json(names)); return; }
    if (!names.length) { c.out('no secrets stored\n'); return; }
    c.out(table(names.map((n) => ({ name: n, source: 'store' + (process.env[n] ? ' (+env)' : '') })), ['name', 'source'], { painter: c.paint }));
  });

  secrets.command('rm').description('Delete a secret').argument('<name>').action((name: string) => {
    const c = ctx();
    if (!c.app.storage.listSecretNames().includes(name)) throw new CliError(`secret ${name} not found`);
    c.app.storage.deleteSecret(name);
    c.ok(`deleted secret ${name}`);
  });
}

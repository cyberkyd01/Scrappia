import { Command, CommanderError } from 'commander';
import { CliContext, CliError, type GlobalOpts } from './context.js';
import { processIO, type CliIO } from './ui.js';
import { registerRunCommands } from './commands/run.js';
import { registerPreviewCommands } from './commands/preview.js';
import { registerRecipeCommands } from './commands/recipes.js';
import { registerRunsCommands } from './commands/runs.js';
import { registerScheduleCommands } from './commands/schedule.js';
import { registerSecretCommands } from './commands/secrets.js';
import { registerAiCommands } from './commands/ai.js';
import { registerMiscCommands } from './commands/misc.js';

export const VERSION = '0.1.0';

/** Build the commander program bound to a context (exported for tests). */
export function createProgram(ctx: CliContext): Command {
  const program = new Command();
  program
    .name('scrappia')
    .description('Scrappia: run visual-scraper recipes headlessly, export datasets, schedule and monitor them.')
    .version(VERSION, '-V, --version')
    .option('--home <dir>', 'data directory (default: $SCRAPPIA_HOME or ~/.scrappia)')
    .option('--log-level <level>', 'debug|info|warn|error (default: $SCRAPPIA_LOG_LEVEL or warn)')
    .showHelpAfterError('(add --help for usage)')
    .showSuggestionAfterError()
    .exitOverride()
    .configureOutput({ writeOut: (s) => ctx.io.out(s), writeErr: (s) => ctx.io.err(s) })
    .hook('preAction', (thisCmd) => { ctx.setGlobals(thisCmd.opts() as GlobalOpts); })
    .addHelpText('after', `
Quick start:
  scrappia examples copy books-toscrape books.json
  scrappia preview books.json                       check selectors on the first page
  scrappia run books.json --pages 2 --out books.csv  scrape and export
  scrappia runs list                                 history
  scrappia recipes add books.json                    save for scheduling / server / MCP
  scrappia schedule add <recipeId> "0 */6 * * *"     then: scrappia serve-scheduler

Data directory: $SCRAPPIA_HOME or ~/.scrappia (SQLite database, exports, browser profiles).`);

  const get = () => ctx;
  registerRunCommands(program, get);
  registerPreviewCommands(program, get);
  registerRecipeCommands(program, get);
  registerRunsCommands(program, get);
  registerScheduleCommands(program, get);
  registerSecretCommands(program, get);
  registerAiCommands(program, get);
  registerMiscCommands(program, get);
  return program;
}

/**
 * Run the CLI with the given user arguments (without node/script). Returns the exit code.
 * Never calls process.exit; the bin entry does that after stdout is flushed.
 */
export async function runCli(argv: string[], io: CliIO = processIO()): Promise<number> {
  const ctx = new CliContext(io);
  const program = createProgram(ctx);
  try {
    await program.parseAsync(argv, { from: 'user' });
    return ctx.exitCode;
  } catch (e) {
    if (e instanceof CommanderError) {
      // help/version print and exit 0; usage errors already printed by commander
      return e.exitCode;
    }
    if (e instanceof CliError) { ctx.fail(e.message); return e.code; }
    const err = e as Error;
    ctx.fail(err?.message ?? String(e));
    if (ctx.logger.level === 'debug' && err?.stack) ctx.err(err.stack + '\n');
    return 1;
  } finally {
    ctx.close();
  }
}

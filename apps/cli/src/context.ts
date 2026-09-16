import { ScrappiaApp, Logger, type LogLevel, type LogEntry } from '@scrappia/core';
import { makePainter, type CliIO, type Painter } from './ui.js';

export interface GlobalOpts { home?: string; logLevel?: string }

/** Thrown by commands to end with a message and an exit code (no stack trace). */
export class CliError extends Error {
  constructor(message: string, public code = 1) { super(message); this.name = 'CliError'; }
}

/**
 * Per-invocation state: IO, colors, the lazily created ScrappiaApp and the exit code.
 * Commands never call process.exit; they set ctx.exitCode and return.
 */
export class CliContext {
  readonly paint: Painter;
  readonly logger: Logger;
  exitCode = 0;
  globals: GlobalOpts = {};
  private appInstance?: ScrappiaApp;
  /** Called when a log line is about to be printed (progress line clears itself). */
  beforeLog?: () => void;
  afterLog?: () => void;

  constructor(readonly io: CliIO) {
    this.paint = makePainter(io.color);
    const level = (process.env.SCRAPPIA_LOG_LEVEL as LogLevel) || 'warn';
    this.logger = new Logger(level);
    this.logger.on((e) => this.printLog(e));
  }

  setGlobals(g: GlobalOpts) {
    this.globals = g;
    if (g.logLevel) {
      if (!['debug', 'info', 'warn', 'error'].includes(g.logLevel)) throw new CliError(`invalid --log-level "${g.logLevel}" (debug|info|warn|error)`);
      this.logger.level = g.logLevel as LogLevel;
    }
  }

  get home(): string | undefined { return this.globals.home ?? process.env.SCRAPPIA_HOME; }

  /** The application facade, created on first use so `--help`/`validate` never touch the database. */
  get app(): ScrappiaApp {
    if (!this.appInstance) this.appInstance = new ScrappiaApp({ dataDir: this.home, logger: this.logger });
    return this.appInstance;
  }
  get hasApp() { return !!this.appInstance; }

  close() { this.appInstance?.close(); this.appInstance = undefined; }

  private printLog(e: LogEntry) {
    const p = this.paint;
    const lvl = e.level === 'error' ? p.red('ERR ') : e.level === 'warn' ? p.yellow('WARN') : e.level === 'debug' ? p.gray('DBG ') : p.dim('INFO');
    const data = e.data && Object.keys(e.data).length ? ' ' + p.dim(safeJson(e.data)) : '';
    this.beforeLog?.();
    this.io.err(`${lvl} ${e.scope ? p.dim(`[${e.scope}] `) : ''}${e.msg}${data}\n`);
    this.afterLog?.();
  }

  // ----- output helpers -----
  out(s: string) { this.io.out(s); }
  err(s: string) { this.io.err(s); }
  ok(s: string) { this.io.err(`${this.paint.green('✔')} ${s}\n`); }
  warn(s: string) { this.io.err(`${this.paint.yellow('!')} ${s}\n`); }
  fail(s: string) { this.io.err(`${this.paint.red('✖')} ${s}\n`); }
}

function safeJson(v: unknown) { try { return JSON.stringify(v); } catch { return String(v); } }

export function parseIntOpt(name: string) {
  return (v: string) => { const n = Number(v); if (!Number.isInteger(n) || n < 0) throw new CliError(`${name} must be a non-negative integer, got "${v}"`); return n; };
}

import type { ActiveRun, RunEvent, RunRecord, RunStats } from '@scrappia/core';
import type { CliContext } from './context.js';
import { fmtDuration, statusColor, table, kv } from './ui.js';

export interface WatchOptions { quiet?: boolean; json?: boolean }

/**
 * Follow an active run: live progress line, drift/alert lines, Ctrl+C cancellation.
 * Resolves with the final run + stats. Listener must be attached before the run emits
 * its first events, so callers subscribe via `app.on` before `startRun` (see runCommand).
 */
export class RunWatcher {
  private line = '';
  private lastPlain = 0;
  private done = false;
  private sigints = 0;
  private off?: () => void;
  private runId?: string;
  private onSigint = () => this.handleSigint();
  private active?: ActiveRun;

  constructor(private ctx: CliContext, private opts: WatchOptions = {}) {}

  get silent() { return !!(this.opts.quiet || this.opts.json); }

  /** Subscribe to app events (call before starting the run). */
  attach() {
    this.off = this.ctx.app.on((e) => this.onEvent(e));
    this.ctx.beforeLog = () => this.clearLine();
    this.ctx.afterLog = () => this.redraw();
    process.on('SIGINT', this.onSigint);
  }

  bind(active: ActiveRun) { this.active = active; this.runId = active.run.id; }

  detach() {
    this.off?.();
    this.ctx.beforeLog = undefined; this.ctx.afterLog = undefined;
    process.off('SIGINT', this.onSigint);
  }

  async wait(active: ActiveRun): Promise<{ run: RunRecord; stats: RunStats }> {
    this.bind(active);
    if (!this.silent) this.ctx.err(`${this.ctx.paint.dim('run')} ${active.run.id}  ${this.ctx.paint.dim('recipe')} ${active.run.recipeName}\n`);
    try {
      const result = await active.promise;
      this.done = true;
      this.finishLine();
      return result;
    } finally { this.detach(); }
  }

  private handleSigint() {
    this.sigints++;
    if (this.sigints === 1 && this.runId) {
      this.clearLine();
      this.ctx.err(`${this.ctx.paint.yellow('cancelling')} run ${this.runId} (press Ctrl+C again to force quit)\n`);
      if (this.active) this.active.runner.cancel(); else this.ctx.app.cancelRun(this.runId);
      this.redraw();
    } else {
      this.ctx.err('\nforce quit\n');
      process.exit(130);
    }
  }

  private onEvent(e: RunEvent) {
    if (this.runId && 'runId' in e && e.runId !== this.runId) return;
    if (this.silent) return;
    const p = this.ctx.paint;
    switch (e.type) {
      case 'run.progress': this.progress(e.stats); break;
      case 'drift': {
        const d = e.event;
        const detail = d.kind === 'healed' ? ` -> ${(d.detail as { selector?: string }).selector ?? ''}` : d.kind === 'fallback-candidate' ? ` (candidate #${(d.detail as { candidate?: number }).candidate ?? '?'})` : '';
        this.printLine(`${p.yellow('drift')} ${d.kind} ${d.template}${d.field ? '.' + d.field : ''}${detail}${d.pageUrl ? p.dim(' @ ' + d.pageUrl) : ''}`);
        break;
      }
      case 'alert': this.printLine(`${p.magenta('alert')} ${e.title}${e.body ? p.dim(' - ' + e.body.split('\n')[0]) : ''}`); break;
      case 'captcha.needed': this.printLine(`${p.red('captcha')} ${e.kind} at ${e.url}`); break;
      case 'export.done': this.printLine(e.result.error ? `${p.red('export failed')} ${e.result.type} ${e.result.target}: ${e.result.error}` : `${p.green('exported')} ${e.result.rows} rows -> ${e.result.target}`); break;
      case 'request.done': if (e.error && this.ctx.logger.level === 'debug') this.printLine(`${p.red('request failed')} ${e.request.url}: ${e.error}`); break;
      default: break;
    }
  }

  private progress(s: RunStats) {
    const p = this.ctx.paint;
    const parts = [
      `${p.bold(String(s.rows))} rows`, `${s.pages} pages`, `${s.requests.pending + s.requests.running} pending`,
      s.requests.failed ? p.red(`${s.requests.failed} failed`) : `0 failed`, `${s.rowsPerMinute} rows/min`, fmtDuration(s.elapsedMs),
    ];
    if (s.drift) parts.push(p.yellow(`${s.drift} drift`));
    const line = parts.join('  ');
    if (this.ctx.io.isTTY) { this.line = line; this.redraw(); }
    else if (Date.now() - this.lastPlain > 5000) { this.lastPlain = Date.now(); this.ctx.err(`progress: ${line}\n`); }
  }

  private printLine(s: string) { this.clearLine(); this.ctx.err(s + '\n'); this.redraw(); }
  private clearLine() { if (this.ctx.io.isTTY && this.line) this.ctx.err('\x1b[2K\r'); }
  private redraw() { if (this.ctx.io.isTTY && this.line && !this.done) this.ctx.err(this.line); }
  private finishLine() { if (this.ctx.io.isTTY && this.line) { this.ctx.err('\x1b[2K\r'); this.line = ''; } }
}

/** Final summary printed after a run (stdout). */
export function printRunSummary(ctx: CliContext, run: RunRecord, stats: RunStats) {
  const p = ctx.paint;
  const datasets = ctx.app.storage.datasets(run.id);
  ctx.out('\n' + kv([
    ['run', run.id],
    ['recipe', run.recipeName],
    ['status', statusColor(p, run.status)],
    ['rows', datasets.length > 1 ? datasets.map((d) => `${d.dataset}: ${d.rows}`).join(', ') : String(stats.rows)],
    ['pages', `${stats.pages} (${stats.httpFetches} http, ${stats.browserFetches} browser)`],
    ['requests', `${stats.requests.done} done, ${stats.requests.failed} failed, ${stats.requests.skipped} skipped`],
    ['drift', stats.drift ? p.yellow(`${stats.drift} event(s)${stats.healed ? `, ${stats.healed} healed` : ''}`) : '0'],
    ['validation', stats.validationFlags || stats.validationDrops ? `${stats.validationFlags} flagged, ${stats.validationDrops} dropped` : 'ok'],
    ['duration', fmtDuration(stats.elapsedMs)],
    ...(stats.monitor ? [['changes', `+${stats.monitor.added} -${stats.monitor.removed} ~${stats.monitor.changed}`] as [string, unknown]] : []),
    ...(stats.aiCalls ? [['ai', `${stats.aiCalls} calls, ${stats.aiTokens} tokens`] as [string, unknown]] : []),
    ...(run.error ? [['error', p.red(run.error)] as [string, unknown]] : []),
  ], p));
  if (stats.exports?.length) {
    ctx.out('\nexports\n' + table(stats.exports.map((e) => ({ type: e.type, rows: e.rows, target: e.target, status: e.error ? p.red('failed: ' + e.error) : p.green('ok') })), ['type', 'rows', 'target', 'status'], { painter: p, maxWidth: 100 }));
  }
}

export function exitCodeFor(status: RunRecord['status']): number {
  return status === 'succeeded' ? 0 : status === 'partial' ? 2 : 1;
}

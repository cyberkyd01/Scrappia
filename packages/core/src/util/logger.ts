export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  level: LogLevel;
  msg: string;
  time: number;
  data?: Record<string, unknown>;
  scope?: string;
}

export type LogListener = (entry: LogEntry) => void;

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  private listeners = new Set<LogListener>();
  constructor(
    public level: LogLevel = 'info',
    private scope?: string,
    private parent?: Logger,
  ) {}

  child(scope: string): Logger {
    return new Logger(this.level, this.scope ? `${this.scope}:${scope}` : scope, this);
  }

  on(listener: LogListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(entry: LogEntry) {
    for (const l of this.listeners) l(entry);
    this.parent?.emit(entry);
  }

  log(level: LogLevel, msg: string, data?: Record<string, unknown>) {
    if (LEVELS[level] < LEVELS[this.level]) return;
    const entry: LogEntry = { level, msg, time: Date.now(), data, scope: this.scope };
    this.emit(entry);
    if (!this.parent && this.listeners.size === 0) {
      const line = `[${new Date(entry.time).toISOString()}] ${level.toUpperCase().padEnd(5)} ${entry.scope ? `(${entry.scope}) ` : ''}${msg}${data ? ' ' + safeJson(data) : ''}`;
      if (level === 'error') console.error(line);
      else if (level === 'warn') console.warn(line);
      else console.log(line);
    }
  }
  debug(msg: string, data?: Record<string, unknown>) { this.log('debug', msg, data); }
  info(msg: string, data?: Record<string, unknown>) { this.log('info', msg, data); }
  warn(msg: string, data?: Record<string, unknown>) { this.log('warn', msg, data); }
  error(msg: string, data?: Record<string, unknown>) { this.log('error', msg, data); }
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}

export const rootLogger = new Logger((process.env.SCRAPPIA_LOG_LEVEL as LogLevel) || 'info');

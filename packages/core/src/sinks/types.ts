import type { Sink as SinkConfig } from '../recipe/schema.js';

export interface SinkContext {
  runId: string;
  recipeName: string;
  dataset: string;
  /** Resolve a credential/connection reference to its secret value. */
  secret(ref: string): string | undefined;
  /** Column order for tabular sinks (already computed by the exporter). */
  columns: string[];
  /** Base directory for relative file paths. */
  outDir: string;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

export type Row = Record<string, unknown>;

export interface SinkWriter {
  /** Called once with all rows (streamed). Must handle mode append/overwrite/upsert. */
  write(rows: AsyncIterable<Row> | Iterable<Row>): Promise<SinkResult>;
}

export interface SinkResult {
  type: string;
  rows: number;
  target: string;
  inserted?: number;
  updated?: number;
  bytes?: number;
}

export type SinkFactory = (config: SinkConfig, ctx: SinkContext) => SinkWriter | Promise<SinkWriter>;

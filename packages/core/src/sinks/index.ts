import type { Sink as SinkConfig } from '../recipe/schema.js';
import type { SinkContext, SinkWriter, SinkFactory } from './types.js';
import { csvSink, jsonSink, jsonlSink, xlsxSink, xmlSink, parquetSink, stdoutSink } from './files.js';
import { sqliteSink, postgresSink, mysqlSink, mongoSink } from './databases.js';
import { googleSheetsSink, airtableSink, notionSink, s3Sink, webhookSink } from './cloud.js';

const registry = new Map<string, SinkFactory>();

export function registerSink(type: string, factory: SinkFactory) { registry.set(type, factory); }

export function createSink(config: SinkConfig, ctx: SinkContext): SinkWriter | Promise<SinkWriter> {
  const f = registry.get(config.type);
  if (!f) throw new Error(`Unknown sink type "${config.type}"`);
  return f(config, ctx);
}

export function sinkTypes(): string[] { return Array.from(registry.keys()); }

registerSink('csv', (c, ctx) => csvSink(c as Extract<SinkConfig, { type: 'csv' }>, ctx));
registerSink('tsv', (c, ctx) => csvSink(c as Extract<SinkConfig, { type: 'tsv' }>, ctx));
registerSink('json', (c, ctx) => jsonSink(c as Extract<SinkConfig, { type: 'json' }>, ctx));
registerSink('jsonl', (c, ctx) => jsonlSink(c as Extract<SinkConfig, { type: 'jsonl' }>, ctx));
registerSink('xlsx', (c, ctx) => xlsxSink(c as Extract<SinkConfig, { type: 'xlsx' }>, ctx));
registerSink('xml', (c, ctx) => xmlSink(c as Extract<SinkConfig, { type: 'xml' }>, ctx));
registerSink('parquet', (c, ctx) => parquetSink(c as Extract<SinkConfig, { type: 'parquet' }>, ctx));
registerSink('stdout', (c, ctx) => stdoutSink(c as Extract<SinkConfig, { type: 'stdout' }>, ctx));
registerSink('sqlite', (c, ctx) => sqliteSink(c as Extract<SinkConfig, { type: 'sqlite' }>, ctx));
registerSink('postgres', (c, ctx) => postgresSink(c as Extract<SinkConfig, { type: 'postgres' }>, ctx));
registerSink('mysql', (c, ctx) => mysqlSink(c as Extract<SinkConfig, { type: 'mysql' }>, ctx));
registerSink('mongodb', (c, ctx) => mongoSink(c as Extract<SinkConfig, { type: 'mongodb' }>, ctx));
registerSink('google-sheets', (c, ctx) => googleSheetsSink(c as Extract<SinkConfig, { type: 'google-sheets' }>, ctx));
registerSink('airtable', (c, ctx) => airtableSink(c as Extract<SinkConfig, { type: 'airtable' }>, ctx));
registerSink('notion', (c, ctx) => notionSink(c as Extract<SinkConfig, { type: 'notion' }>, ctx));
registerSink('s3', (c, ctx) => s3Sink(c as Extract<SinkConfig, { type: 's3' }>, ctx));
registerSink('webhook', (c, ctx) => webhookSink(c as Extract<SinkConfig, { type: 'webhook' }>, ctx));

export * from './types.js';
export { toTabular, columnsOf, sinkRowKey } from './files.js';

#!/usr/bin/env node
/**
 * `scrappia` bin entry. All behaviour lives in ./cli.js so tests can drive it in-process.
 */
import { runCli } from './cli.js';


const code = await runCli(process.argv.slice(2));
// flush stdout (async on Windows pipes) before exiting; explicit exit also drops keep-alive sockets
process.stdout.write('', () => process.exit(code));

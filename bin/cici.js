#!/usr/bin/env node
import { main } from '../src/cli.js';

// A reader that goes away (`cici | head`, quitting a pager, a typo'd command)
// makes the next write fail with EPIPE. Nobody listens for 'error' on these
// streams by default, so Node would print an unhandled-error stack trace from
// what is meant to be a read-only diagnostic tool.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err) => {
    if (err && err.code === 'EPIPE') process.exit(0);
  });
}

let code;
try {
  code = await main(process.argv.slice(2), {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    columns: process.stdout.columns,
  });
} catch (err) {
  process.stderr.write(`cici: ${err && err.message ? err.message : String(err)}\n`);
  code = 1;
}

// Set the exit code instead of calling process.exit() so piped stdout (which is
// asynchronous on macOS/Windows) is flushed before the process ends.
process.exitCode = code;

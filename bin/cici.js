#!/usr/bin/env node
import { main } from '../src/cli.js';

const code = await main(process.argv.slice(2), {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
});

// Set the exit code instead of calling process.exit() so piped stdout (which is
// asynchronous on macOS/Windows) is flushed before the process ends.
process.exitCode = code;

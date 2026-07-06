#!/usr/bin/env node

import { installLocal } from '../src/install-local.mjs';

const options = parseArgs(process.argv.slice(2));

installLocal(process.cwd(), options)
  .then((result) => {
    process.stdout.write(`${result.path}\n`);
  })
  .catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });

function parseArgs(argv) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg !== '--dir' && arg !== '--name') {
      throw new Error(`Unknown option: ${arg}`);
    }

    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${arg} requires a value`);
    }

    index += 1;
    if (arg === '--dir') {
      options.dir = value;
    } else {
      options.name = value;
    }
  }

  return options;
}

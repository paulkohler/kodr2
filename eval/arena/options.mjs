/** Parse the arena's command-line filters and optional model override. */
import { resolve } from 'node:path';

export function parseArgs(argv) {
  const opts = {
    task: null,
    variant: null,
    repeats: 0,
    jobsDir: null,
    model: null,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--task') {
      opts.task = argv[++i];
    } else if (argv[i] === '--variant') {
      opts.variant = argv[++i];
    } else if (argv[i] === '--repeats') {
      opts.repeats = Number.parseInt(argv[++i], 10) || 0;
    } else if (argv[i] === '--jobs-dir') {
      opts.jobsDir = argv[++i];
    } else if (argv[i] === '--model') {
      opts.model = argv[++i];
    }
  }
  return opts;
}

/** Select the command-line model, falling back to the checked-in config. */
export function selectModel(config, opts) {
  if (opts.model) {
    return opts.model;
  }
  return config.model;
}

/** Resolve a cell's record directory before its temporary workspace is used. */
export function recordDirFor(jobsDir, variant, repeat) {
  return resolve(jobsDir, 'records', `${variant}-${repeat}`);
}

/**
 * Advisory spec-schema check.
 *
 * Every file in specs/ is the contract for a feature (see AGENTS.md). This
 * warns when a spec drifts from the shared shape or uses ambiguous sequence
 * formatting that can turn prose into YAML syntax.
 *
 * Warnings only by default (exit 0) so it never blocks a commit; pass
 * --strict to exit non-zero, e.g. to gate CI once the specs are clean.
 *
 * Zero-dependency by design: specs are flat top-level YAML keys, so a line
 * scan reads all we check without pulling in a YAML parser.
 */

import { readdir, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const REQUIRED_KEYS = ['name', 'status', 'description'];
const STATUSES = ['proposed', 'accepted', 'implemented', 'deprecated'];

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main(process.argv);
}

async function main(argv) {
  const specsDir = new URL('../specs/', import.meta.url);
  const strict = argv.includes('--strict');
  const files = (await readdir(specsDir))
    .filter((name) => name.endsWith('.yaml'))
    .sort();

  const warnings = [];
  for (const file of files) {
    const text = await readFile(new URL(file, specsDir), 'utf8');
    warnings.push(...lintSpec(file, text));
  }

  for (const warning of warnings) {
    process.stderr.write(`${warning}\n`);
  }

  if (warnings.length === 0) {
    process.stdout.write(`checked ${files.length} specs, no issues\n`);
  } else {
    process.stderr.write(
      `\n${warnings.length} warning(s) across ${files.length} specs\n`,
    );
    if (strict) {
      process.exitCode = 1;
    }
  }
}

/**
 * @param {string} file
 * @param {string} text
 * @returns {string[]}
 */
export function lintSpec(file, text) {
  const out = [];
  const keys = topLevelKeys(text);
  for (const key of REQUIRED_KEYS) {
    if (!keys.has(key)) {
      out.push(`${file}: missing top-level "${key}"`);
    }
  }
  const status = scalar(text, 'status');
  if (status && !STATUSES.includes(status)) {
    out.push(`${file}: status "${status}" not one of ${STATUSES.join(', ')}`);
  }
  out.push(...sequenceFormattingWarnings(file, text));
  return out;
}

/**
 * Find sequence prose that relies on ambiguous YAML plain-scalar rules.
 * @param {string} file
 * @param {string} text
 * @returns {string[]}
 */
function sequenceFormattingWarnings(file, text) {
  const lines = text.split('\n');
  const warnings = [];
  let blockIndent = null;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const indent = leadingSpaces(line);
    const trimmed = line.trim();

    if (blockIndent !== null) {
      if (trimmed === '' || indent > blockIndent) {
        continue;
      }
      blockIndent = null;
    }

    if (isBlockScalarHeader(line)) {
      blockIndent = indent;
      continue;
    }

    const match = /^(\s*)-\s+(.+?)\s*$/.exec(line);
    if (!match) {
      continue;
    }
    const itemIndent = match[1].length;
    const value = match[2];
    const next = nextContentLine(lines, index + 1);
    const continued = next !== null && leadingSpaces(lines[next]) > itemIndent;
    const quoted = isFullyQuoted(value);
    const mapping = isSequenceMapping(value, lines, next, itemIndent);
    const partialQuote = startsQuote(value) && !quoted;
    const unsafePlain = value.includes(': ') || value.startsWith('`');

    if (!mapping && !quoted && (continued || partialQuote || unsafePlain)) {
      warnings.push(
        `${file}:${index + 1}: sequence prose must use an explicit block scalar`,
      );
    }
  }
  return warnings;
}

function leadingSpaces(line) {
  return /^\s*/.exec(line)[0].length;
}

function isBlockScalarHeader(line) {
  return /^\s*(?:[^#\n]+:\s*|-\s*)[>|][-+]?\s*(?:#.*)?$/.test(line);
}

function nextContentLine(lines, start) {
  for (let index = start; index < lines.length; index++) {
    if (lines[index].trim() !== '') {
      return index;
    }
  }
  return null;
}

function startsQuote(value) {
  return value.startsWith('"') || value.startsWith("'");
}

function isFullyQuoted(value) {
  if (!startsQuote(value)) {
    return false;
  }
  return value.length >= 2 && value.at(-1) === value[0];
}

function isSequenceMapping(value, lines, next, indent) {
  if (!/^[A-Za-z][\w.-]*:\s+\S/.test(value) || next === null) {
    return false;
  }
  const nextLine = lines[next];
  return (
    leadingSpaces(nextLine) > indent &&
    /^\s+[A-Za-z][\w.-]*:\s*/.test(nextLine)
  );
}

/**
 * Top-level keys are the only ones anchored at column 0; nested keys and list
 * items are indented, so a leading-anchor match is enough to isolate them.
 * @param {string} text
 * @returns {Set<string>}
 */
function topLevelKeys(text) {
  const keys = new Set();
  for (const line of text.split('\n')) {
    const match = /^([A-Za-z][\w-]*):/.exec(line);
    if (match) {
      keys.add(match[1]);
    }
  }
  return keys;
}

/**
 * Read a top-level scalar value (same line as its key), unquoted.
 * @param {string} text
 * @param {string} key
 * @returns {string}
 */
function scalar(text, key) {
  const matcher = new RegExp(`^${key}:[ \\t]*(.*)$`);
  for (const line of text.split('\n')) {
    const match = matcher.exec(line);
    if (match) {
      return unquote(match[1].trim());
    }
  }
  return '';
}

/**
 * @param {string} value
 * @returns {string}
 */
function unquote(value) {
  const quoted =
    value.length >= 2 &&
    (value.startsWith('"') || value.startsWith("'")) &&
    value.at(-1) === value[0];
  if (quoted) {
    return value.slice(1, -1);
  }
  return value;
}

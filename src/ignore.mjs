/**
 * Shared workspace ignore rules for generated metadata and operator artifacts.
 */

const IGNORED_NAMES = new Set(['.git', 'node_modules', '.kodr', 'kodr']);
const IGNORED_FILE_PATTERNS = [/^run\d*\.log$/];

export function shouldIgnoreEntry(name) {
  if (IGNORED_NAMES.has(name)) return true;
  for (const pattern of IGNORED_FILE_PATTERNS) {
    if (pattern.test(name)) return true;
  }
  return false;
}

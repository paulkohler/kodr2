/**
 * Shared workspace ignore rules for generated metadata, operator artifacts,
 * and common build/dependency directories across ecosystems.
 *
 * These names are excluded from the workspace file listing only — the model can
 * still read any path directly. Keeping them out of the listing stops a single
 * build (e.g. Rust's target/, 100s–1000s of files) from flooding the system
 * prompt and crowding out real source under a small context window.
 */

const IGNORED_NAMES = new Set([
  '.git',
  '.kodr',
  'kodr',
  'node_modules',
  'target',
  'dist',
  'build',
  '.next',
  '__pycache__',
  '.venv',
  'venv',
  '.gradle',
]);
const IGNORED_FILE_PATTERNS = [/^run.*\.log$/];

export function shouldIgnoreEntry(name) {
  if (IGNORED_NAMES.has(name)) {
    return true;
  }
  for (const pattern of IGNORED_FILE_PATTERNS) {
    if (pattern.test(name)) {
      return true;
    }
  }
  return false;
}

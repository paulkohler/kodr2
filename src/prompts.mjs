/**
 * Prompt loader -- static model-facing prompt text lives in prompts/*.md
 * (see specs/prompts.yaml) so wording can be edited as prose, without
 * touching program logic. Dynamic prompt parts stay in the consumers.
 *
 * Throws on a missing or empty file, deliberately, despite this repo's
 * errors-as-return-values convention: it is a packaging bug, not a runtime
 * condition to degrade through, and consumers load prompts at module
 * import -- failing the import beats a model silently running with an
 * empty system prompt.
 */

import { readFileSync } from 'node:fs';

/**
 * Load prompts/<name>.md, resolved relative to the package itself (not the
 * process cwd), trimmed.
 * @param {string} name - Prompt file basename, no extension
 * @returns {string}
 */
export function loadPrompt(name) {
  const url = new URL(`../prompts/${name}.md`, import.meta.url);
  let content;
  try {
    content = readFileSync(url, 'utf8');
  } catch {
    throw new Error(`prompt file missing: prompts/${name}.md`);
  }
  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error(`prompt file empty: prompts/${name}.md`);
  }
  return trimmed;
}

/**
 * Workspace context assembly.
 * Reads workspace instructions and builds the file listing
 * that goes into the system prompt.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { shouldIgnoreEntry } from './ignore.mjs';
import { readMemory } from './memory.mjs';
import { resolveExistingPath } from './path-jail.mjs';
import { loadPrompt } from './prompts.mjs';
import { discoverSkills } from './skills.mjs';

const INSTRUCTION_FILES = ['KODR.md', 'AGENTS.md'];
export const MAX_FILES = 200;

/**
 * Disclose the workspace root's absolute path and the path convention. Tool
 * paths are relative to the root, but the model is never otherwise told what
 * that root *is* -- so when a task refers to an absolute path that happens to
 * live under the root (e.g. write to "/app/out.txt" when the root is "/app"),
 * the model can't relativize it correctly and may strip only the leading slash
 * ("app/out.txt"), which then nests a level too deep. Stating the root, and
 * that an absolute path inside it is accepted, removes that trap.
 * @param {string} cwd - Workspace root (absolute path)
 * @returns {string}
 */
function workspaceRootNote(cwd) {
  return [
    `The workspace root is the absolute path: ${cwd}`,
    `Tool paths are relative to this root ("src/app.js" means "${join(cwd, 'src/app.js')}"). You may also pass an absolute path as long as it is inside the workspace root -- so if a task names an absolute path under the root, pass it exactly as given rather than trying to relativize it.`,
  ].join('\n');
}

/**
 * Assemble the system prompt for a workspace.
 * @param {string} cwd - Workspace root
 * @param {object} [options]
 * @param {string|null} [options.memory] - Pre-fetched MEMORY.md content. Reads it
 *   itself when omitted; callers that also need the content separately (e.g. for a
 *   size-cap notice) should read it once and pass it through here instead, so the
 *   file can't change between two independent reads.
 * @returns {Promise<string>}
 */
export async function buildSystemPrompt(cwd, options = {}) {
  const parts = [BASE_PROMPT, workspaceRootNote(cwd)];

  const instructions = await readInstructions(cwd);
  if (instructions) {
    parts.push('<workspace-instructions>');
    parts.push(instructions);
    parts.push('</workspace-instructions>');
  }

  // Distinct from <workspace-instructions>: one is human-authored, the
  // other is human-approved-but-agent-written -- always loaded when
  // MEMORY.md exists, regardless of whether a new retrospective runs for
  // this particular run.
  const memory =
    options.memory !== undefined ? options.memory : await readMemory(cwd);
  if (memory) {
    parts.push('<memory>');
    parts.push(
      'Lessons proposed by a prior run in this workspace and approved by a human.',
    );
    parts.push(memory);
    parts.push('</memory>');
  }

  const skills = await discoverSkills(cwd);
  if (skills.length > 0) {
    parts.push('<available-skills>');
    parts.push(
      'These skills hold specialized instructions for specific tasks. When a task matches a skill, call the load_skill tool with its name to retrieve the full instructions before proceeding.',
    );
    for (const skill of skills) {
      parts.push(`- ${skill.name}: ${skill.description}`);
    }
    parts.push('</available-skills>');
  }

  const listing = await listWorkspaceFiles(cwd);
  if (listing.files.length > 0) {
    parts.push('<workspace-files>');
    parts.push(listing.files.join('\n'));
    if (listing.truncated) {
      parts.push(
        `(listing truncated at ${MAX_FILES} files -- use list_files or search for the rest)`,
      );
    }
    parts.push('</workspace-files>');
  }

  return parts.join('\n\n');
}

/**
 * Read workspace instruction files (KODR.md or AGENTS.md).
 * First one found wins.
 * @param {string} cwd
 * @returns {Promise<string|null>}
 */
export async function readInstructions(cwd) {
  for (const name of INSTRUCTION_FILES) {
    try {
      const path = await resolveExistingPath(cwd, name);
      if (!path) {
        continue;
      }
      const content = await readFile(path, 'utf8');
      if (content.trim()) {
        return content.trim();
      }
    } catch {
      // not found, try next
    }
  }
  return null;
}

/**
 * Build a flat file listing of the workspace. The walk stops at MAX_FILES;
 * `truncated` reports whether it did, so the prompt can mark the listing as
 * incomplete -- a model shown a silently partial listing concludes the
 * missing files don't exist instead of looking for them.
 * @param {string} cwd
 * @returns {Promise<{ files: string[], truncated: boolean }>}
 */
export async function listWorkspaceFiles(cwd) {
  const files = [];
  const truncated = await walk(cwd, cwd, files);
  return { files, truncated };
}

async function walk(dir, root, files) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }

  let truncated = false;
  for (const entry of entries) {
    if (shouldIgnoreEntry(entry.name)) {
      continue;
    }
    // A non-ignored entry remains once the cap is hit: the listing is
    // incomplete. (A directory here may turn out empty -- counted as
    // truncated anyway rather than walking it just to find out.)
    if (files.length >= MAX_FILES) {
      return true;
    }

    const full = join(dir, entry.name);
    const rel = relative(root, full);

    if (entry.isDirectory()) {
      if (await walk(full, root, files)) {
        truncated = true;
      }
    } else {
      files.push(rel);
    }
  }
  return truncated;
}

const BASE_PROMPT = loadPrompt('system');

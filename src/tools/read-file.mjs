/**
 * read_file tool — read file contents, path-jailed to workspace.
 */

import { stat } from 'node:fs/promises';
import { resolveExistingPath } from '../path-jail.mjs';
import { localBackend } from './backend.mjs';

export const DEFAULT_MAX_READ_BYTES = 1024 * 1024; // 1 MB
// Same default as run_command's per-stream output cap (shell.mjs): both are
// "how much of one tool result may enter the conversation" limits.
export const DEFAULT_MAX_READ_CHARS = 50_000;

/**
 * Hard byte cap on what read_file will pull off disk (or accept from a
 * delegated backend read). Resolved from a registry option, then
 * KODR_MAX_READ_BYTES, then the default -- overridable per AGENTS.md, so a
 * workspace with a legitimately large text fixture can raise it instead of
 * routing around the tool through run_command.
 * @param {{ maxReadBytes?: number }} [context]
 * @returns {number}
 */
export function maxReadBytes(context) {
  const option = context?.maxReadBytes;
  if (Number.isInteger(option) && option > 0) {
    return option;
  }
  const fromEnv = Number.parseInt(process.env.KODR_MAX_READ_BYTES || '', 10);
  if (Number.isInteger(fromEnv) && fromEnv > 0) {
    return fromEnv;
  }
  return DEFAULT_MAX_READ_BYTES;
}

/**
 * Soft cap on characters returned into the conversation per read. A read
 * over it is truncated at a line boundary with a paging note -- a huge file
 * "successfully" read into a small context window would otherwise blow the
 * window before compaction can help. Resolved from a registry option, then
 * KODR_MAX_READ_CHARS, then the default.
 * @param {{ maxReadChars?: number }} [context]
 * @returns {number}
 */
export function maxReadChars(context) {
  const option = context?.maxReadChars;
  if (Number.isInteger(option) && option > 0) {
    return option;
  }
  const fromEnv = Number.parseInt(process.env.KODR_MAX_READ_CHARS || '', 10);
  if (Number.isInteger(fromEnv) && fromEnv > 0) {
    return fromEnv;
  }
  return DEFAULT_MAX_READ_CHARS;
}

export default {
  definition: {
    name: 'read_file',
    description:
      'Read the contents of a file. Path is relative to the workspace root. Optionally pass offset (1-based start line) and limit (line count) to read a range; long files are returned truncated with a note, so page through them with offset/limit. Returns an error for binary files.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Path relative to the workspace root, or an absolute path within it',
        },
        offset: {
          type: 'integer',
          description: '1-based line number to start reading from (optional)',
        },
        limit: {
          type: 'integer',
          description: 'Maximum number of lines to return (optional)',
        },
      },
      required: ['path'],
    },
  },

  /**
   * @param {{ path?: string, offset?: number, limit?: number }} args -
   *   Model-supplied, so every field is validated rather than assumed
   * @param {import('./index.mjs').ToolContext} context
   */
  async execute({ path, offset, limit }, context) {
    if (!path) {
      return {
        error: 'path is required — read_file needs { "path": "<file>" }',
      };
    }
    const rangeError = validateRange(offset, limit);
    if (rangeError) {
      return { error: rangeError };
    }

    let resolved;
    try {
      resolved = await resolveExistingPath(context.cwd, path);
    } catch {
      return { error: `file not found: ${path}` };
    }
    if (!resolved) {
      return { error: 'path escapes workspace root' };
    }

    const byteCap = maxReadBytes(context);
    try {
      const info = await stat(resolved);
      if (!info.isFile()) {
        return { error: 'not a file' };
      }
      if (info.size > byteCap) {
        return {
          error: `file too large: ${info.size} bytes (max ${byteCap})`,
        };
      }
    } catch {
      return { error: `file not found: ${path}` };
    }

    // The stat above is Kodr's own view of the file; only the byte read is
    // delegable, so an ACP client can return the content of an unsaved editor
    // buffer instead of what's on disk.
    const backend = context.backend ?? localBackend;
    const read = await backend.readTextFile(resolved);
    if (read.error) {
      return { error: read.error };
    }
    // Re-apply the size cap to what was actually read: a delegated read can
    // return an unsaved buffer far larger than the on-disk stat above, so the
    // local stat alone can't bound what enters the context.
    const bytes = Buffer.byteLength(read.content, 'utf8');
    if (bytes > byteCap) {
      return { error: `file too large: ${bytes} bytes (max ${byteCap})` };
    }
    if (isBinary(read.content)) {
      return { error: 'binary file — cannot read as text' };
    }

    const charCap = maxReadChars(context);
    if (offset !== undefined || limit !== undefined) {
      return sliceRead(read.content, offset, limit, charCap);
    }
    return fullRead(read.content, charCap);
  },
};

/**
 * offset/limit are model-supplied: reject anything but positive integers with
 * an error that names the expected shape, rather than silently coercing.
 * @param {unknown} offset
 * @param {unknown} limit
 * @returns {string|null}
 */
function validateRange(offset, limit) {
  if (offset !== undefined && !isPositiveInteger(offset)) {
    return 'offset must be a positive integer (1-based line number)';
  }
  if (limit !== undefined && !isPositiveInteger(limit)) {
    return 'limit must be a positive integer (number of lines)';
  }
  return null;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPositiveInteger(value) {
  if (typeof value !== 'number') {
    return false;
  }
  return Number.isInteger(value) && value >= 1;
}

/**
 * A full-file read. The common small-file case keeps the plain { content }
 * shape; only an over-cap read gains the truncation fields, so the model
 * (and existing callers) see no change until the cap matters.
 * @param {string} content
 * @param {number} charCap
 */
function fullRead(content, charCap) {
  if (content.length <= charCap) {
    return { content };
  }
  const total = countLines(content);
  const cut = cutAtLineBoundary(content, charCap);
  return {
    content: cut.text,
    truncated: true,
    totalLines: total,
    note: `showing lines 1-${cut.lines} of ${total}; pass offset/limit to read more`,
  };
}

/**
 * A ranged read: 1-based offset, limit lines. The character cap still
 * applies to the slice, so a range of pathologically long lines cannot smuggle
 * an oversized result past it.
 * @param {string} content
 * @param {number|undefined} offset
 * @param {number|undefined} limit
 * @param {number} charCap
 */
function sliceRead(content, offset, limit, charCap) {
  const start = offset === undefined ? 1 : offset;
  const allLines = splitLines(content);
  const total = allLines.length;
  if (start > total) {
    return {
      error: `offset ${start} is past the end of the file (${total} lines)`,
    };
  }
  const count = limit === undefined ? total - start + 1 : limit;
  const slice = allLines.slice(start - 1, start - 1 + count).join('\n');
  const returned = Math.min(count, total - start + 1);
  if (slice.length <= charCap) {
    return {
      content: slice,
      offset: start,
      lines: returned,
      totalLines: total,
    };
  }
  const cut = cutAtLineBoundary(slice, charCap);
  return {
    content: cut.text,
    offset: start,
    lines: cut.lines,
    totalLines: total,
    truncated: true,
    note: `showing lines ${start}-${start + cut.lines - 1} of ${total}; the range was over the size cap`,
  };
}

/**
 * Split into lines without counting a trailing newline as an extra empty
 * line -- "a\nb\n" is two lines, not three.
 * @param {string} content
 * @returns {string[]}
 */
function splitLines(content) {
  const lines = content.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

function countLines(content) {
  return splitLines(content).length;
}

/**
 * Cut text at the last line boundary within max characters, so a truncated
 * read never ends mid-line. A single line longer than the cap is cut hard --
 * there is no boundary to respect.
 * @param {string} text
 * @param {number} max
 * @returns {{ text: string, lines: number }}
 */
function cutAtLineBoundary(text, max) {
  const hard = text.slice(0, max);
  const lastNewline = hard.lastIndexOf('\n');
  if (lastNewline <= 0) {
    return { text: hard, lines: 1 };
  }
  const cut = hard.slice(0, lastNewline);
  return { text: cut, lines: countLines(cut) };
}

function isBinary(content) {
  for (let i = 0; i < Math.min(content.length, 8192); i++) {
    const code = content.charCodeAt(i);
    if (code === 0) {
      return true;
    }
  }
  return false;
}

/**
 * The filesystem/exec backend behind the file and command tools (see
 * specs/acp.yaml). read_file/write_file/edit_file do their byte I/O through
 * `readTextFile`/`writeTextFile`, and run_command executes through
 * `runCommand`, instead of touching node:fs / the shell directly. The default
 * is the local backend below; the ACP front-end (src/acp-backend.mjs) swaps in
 * one that delegates to the editor's fs/* and terminal/* when the client
 * advertises those capabilities.
 *
 * The seam is deliberately narrow: path-jail resolution, size/binary checks,
 * changed-file snapshots, and tracking all stay in the tools. The backend only
 * owns the final read, write, or command execution -- the one place that a
 * client can meaningfully take over.
 *
 * @typedef {{ cwd: string, env?: Record<string, string>, timeout?: number }} RunCommandOpts
 * @typedef {object} ToolBackend
 * @property {(absPath: string) => Promise<{ content?: string, error?: string }>} readTextFile
 * @property {(absPath: string, content: string) => Promise<{ error?: string, [k: string]: any }>} writeTextFile
 * @property {(command: string, opts: RunCommandOpts) => Promise<{ stdout: string, stderr: string, exitCode: number, filesChanged?: string[] }>} runCommand
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { runShell } from '../shell.mjs';

/**
 * The local, in-process backend: node:fs reads/writes and a real child process
 * for commands. This is the behavior every tool had before the seam existed, so
 * a run with no backend override is byte-for-byte unchanged.
 * @returns {ToolBackend}
 */
export function createLocalBackend() {
  return {
    async readTextFile(absPath) {
      try {
        return { content: await readFile(absPath, 'utf8') };
      } catch (e) {
        return { error: e.message };
      }
    },

    async writeTextFile(absPath, content) {
      try {
        await mkdir(dirname(absPath), { recursive: true });
        await writeFile(absPath, content, 'utf8');
        return {};
      } catch (e) {
        return { error: e.message };
      }
    },

    runCommand(command, opts) {
      return runShell(command, opts.cwd, opts);
    },
  };
}

/**
 * A shared local backend. Stateless, so a single instance is safe to reuse as
 * the default when a tool context carries no backend override (e.g. every
 * existing unit test that builds a context by hand).
 * @type {ToolBackend}
 */
export const localBackend = createLocalBackend();

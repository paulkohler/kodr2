/**
 * Tool registry — collects tools, generates API schemas, dispatches calls.
 */

import { localBackend } from './backend.mjs';
import editFile from './edit-file.mjs';
import listFiles from './list-files.mjs';
import loadSkill from './load-skill.mjs';
import readFile from './read-file.mjs';
import runCommand from './run-command.mjs';
import search from './search.mjs';
import viewImage from './view-image.mjs';
import writeFile from './write-file.mjs';

const ALL_TOOLS = [
  readFile,
  writeFile,
  editFile,
  listFiles,
  search,
  runCommand,
  loadSkill,
];

// Only offered when vision is enabled (--vision / KODR_VISION); see
// specs/vision.yaml. Kept out of ALL_TOOLS so a text-only model never sees it.
const VISION_TOOLS = [viewImage];

/**
 * @typedef {object} ToolRegistry
 * @property {() => Array} definitions
 * @property {(name: string, args: object) => Promise<object>} dispatch
 * @property {() => string[]} filesChanged
 * @property {() => number} commandsRun
 * @property {() => string[]} packageCommands
 */

/**
 * Create a tool registry bound to a workspace.
 * @param {string} cwd - Workspace root (absolute path)
 * @param {object} [options]
 * @param {string[]} [options.envPassthrough] - Extra env var names for run_command
 * @param {number} [options.commandTimeoutMs] - Default shell timeout for run_command
 * @param {number} [options.snapshotCap] - Max files run_command's changed-file
 *   snapshot walks (also KODR_SNAPSHOT_CAP; default 1000). Raise it for a large
 *   workspace so a changed file past the cap isn't dropped from tracking.
 * @param {Date} [options.startedAt] - Run start, for remaining-budget timeouts
 * @param {number} [options.maxRunMs] - Overall run budget in ms
 * @param {string[]} [options.allowedTools] - Restrict the registry to these
 *   tool names (e.g. a read-only review pass). Omitted means every tool.
 * @param {string[]} [options.initialFilesChanged] - Seed filesChanged() with
 *   these paths up front (e.g. a --continue session's prior run touched
 *   them but never got them committed) so this session's own tracking
 *   reflects the full set of changes still sitting in the working tree,
 *   not just what this specific process touches.
 * @param {boolean} [options.vision] - Offer the view_image tool (see specs/vision.yaml)
 * @param {number} [options.maxImageBytes] - Size cap for view_image reads
 * @param {import('./backend.mjs').ToolBackend} [options.backend] - Filesystem/exec
 *   backend for the file and command tools (see specs/acp.yaml). Defaults to the
 *   local, in-process backend; the ACP front-end injects one that delegates
 *   reads/writes/commands to the editor when it advertises fs/* and terminal/*.
 * @returns {ToolRegistry}
 */
export function createToolRegistry(cwd, options = {}) {
  const filesChanged = [...new Set(options.initialFilesChanged ?? [])];
  const packageCommands = [];
  let commandCount = 0;

  const context = {
    cwd,
    envPassthrough: options.envPassthrough ?? [],
    commandTimeoutMs: options.commandTimeoutMs,
    snapshotCap: options.snapshotCap,
    startedAt: options.startedAt,
    maxRunMs: options.maxRunMs ?? 0,
    maxImageBytes: options.maxImageBytes,
    backend: options.backend ?? localBackend,
    trackWrite(path) {
      if (!filesChanged.includes(path)) {
        filesChanged.push(path);
      }
    },
    trackCommand() {
      commandCount++;
    },
    trackPackageCommand(command) {
      packageCommands.push(command);
    },
  };

  const pool = options.vision ? [...ALL_TOOLS, ...VISION_TOOLS] : ALL_TOOLS;
  const activeTools = options.allowedTools
    ? pool.filter((tool) => options.allowedTools.includes(tool.definition.name))
    : pool;

  const toolMap = new Map();
  for (const tool of activeTools) {
    toolMap.set(tool.definition.name, tool);
  }

  return {
    /**
     * Tool definitions for the chat completions API.
     * @returns {Array}
     */
    definitions() {
      return activeTools.map((t) => t.definition);
    },

    /**
     * Execute a tool call by name.
     * @param {string} name - Tool name
     * @param {object} args - Tool arguments (parsed JSON)
     * @returns {Promise<object>} Tool result
     */
    async dispatch(name, args) {
      const tool = toolMap.get(name);
      if (!tool) {
        return { error: `unknown tool: ${name}` };
      }
      if (!isPlainObject(args)) {
        return { error: 'tool arguments must be a JSON object' };
      }
      return tool.execute(args, context);
    },

    /**
     * List of files written during this run.
     * @returns {string[]}
     */
    filesChanged() {
      return [...filesChanged];
    },

    /**
     * Number of shell commands executed during this run.
     * @returns {number}
     */
    commandsRun() {
      return commandCount;
    },

    /**
     * Package-manager commands observed during this run.
     * @returns {string[]}
     */
    packageCommands() {
      return [...packageCommands];
    },
  };
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object') {
    return false;
  }
  return !Array.isArray(value);
}

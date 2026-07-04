/**
 * Tool registry — collects tools, generates API schemas, dispatches calls.
 */

import editFile from './edit-file.mjs';
import listFiles from './list-files.mjs';
import loadSkill from './load-skill.mjs';
import readFile from './read-file.mjs';
import runCommand from './run-command.mjs';
import search from './search.mjs';
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

/**
 * Create a tool registry bound to a workspace.
 * @param {string} cwd - Workspace root (absolute path)
 * @param {object} [options]
 * @param {string[]} [options.envPassthrough] - Extra env var names for run_command
 * @param {number} [options.commandTimeoutMs] - Default shell timeout for run_command
 * @param {Date} [options.startedAt] - Run start, for remaining-budget timeouts
 * @param {number} [options.maxRunMs] - Overall run budget in ms
 * @param {string[]} [options.allowedTools] - Restrict the registry to these
 *   tool names (e.g. a read-only review pass). Omitted means every tool.
 * @returns {object} Registry with `definitions`, `dispatch`, and `context`
 */
export function createToolRegistry(cwd, options = {}) {
  const filesChanged = [];
  const packageCommands = [];
  let commandCount = 0;

  const context = {
    cwd,
    envPassthrough: options.envPassthrough ?? [],
    commandTimeoutMs: options.commandTimeoutMs,
    startedAt: options.startedAt,
    maxRunMs: options.maxRunMs ?? 0,
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

  const activeTools = options.allowedTools
    ? ALL_TOOLS.filter((tool) =>
        options.allowedTools.includes(tool.definition.name),
      )
    : ALL_TOOLS;

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

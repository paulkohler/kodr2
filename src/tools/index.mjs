/**
 * Tool registry — collects tools, generates API schemas, dispatches calls.
 */

import readFile from './read-file.mjs';
import writeFile from './write-file.mjs';
import editFile from './edit-file.mjs';
import listFiles from './list-files.mjs';
import search from './search.mjs';
import runCommand from './run-command.mjs';

const ALL_TOOLS = [
	readFile,
	writeFile,
	editFile,
	listFiles,
	search,
	runCommand,
];

/**
 * Create a tool registry bound to a workspace.
 * @param {string} cwd - Workspace root (absolute path)
 * @returns {object} Registry with `definitions`, `dispatch`, and `context`
 */
export function createToolRegistry(cwd) {
	const filesChanged = [];

	const context = {
		cwd,
		trackWrite(path) {
			if (!filesChanged.includes(path)) {
				filesChanged.push(path);
			}
		},
	};

	const toolMap = new Map();
	for (const tool of ALL_TOOLS) {
		toolMap.set(tool.definition.name, tool);
	}

	return {
		/**
		 * Tool definitions for the chat completions API.
		 * @returns {Array}
		 */
		definitions() {
			return ALL_TOOLS.map((t) => t.definition);
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
			return tool.execute(args, context);
		},

		/**
		 * List of files written during this run.
		 * @returns {string[]}
		 */
		filesChanged() {
			return [...filesChanged];
		},
	};
}

/**
 * Workspace context assembly.
 * Reads workspace instructions and builds the file listing
 * that goes into the system prompt.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { resolveExistingPath } from './path-jail.mjs';
import { discoverSkills } from './skills.mjs';

const INSTRUCTION_FILES = ['KODR.md', 'AGENTS.md'];
const IGNORE = new Set(['.git', 'node_modules', '.kodr']);
const MAX_FILES = 200;

/**
 * Assemble the system prompt for a workspace.
 * @param {string} cwd - Workspace root
 * @returns {Promise<string>}
 */
export async function buildSystemPrompt(cwd) {
	const parts = [BASE_PROMPT];

	const instructions = await readInstructions(cwd);
	if (instructions) {
		parts.push('<workspace-instructions>');
		parts.push(instructions);
		parts.push('</workspace-instructions>');
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

	const files = await listWorkspaceFiles(cwd);
	if (files.length > 0) {
		parts.push('<workspace-files>');
		parts.push(files.join('\n'));
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
			if (!path) continue;
			const content = await readFile(path, 'utf8');
			if (content.trim()) return content.trim();
		} catch {
			// not found, try next
		}
	}
	return null;
}

/**
 * Build a flat file listing of the workspace.
 * @param {string} cwd
 * @returns {Promise<string[]>}
 */
export async function listWorkspaceFiles(cwd) {
	const files = [];
	await walk(cwd, cwd, files);
	return files;
}

async function walk(dir, root, files) {
	if (files.length >= MAX_FILES) return;

	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		if (files.length >= MAX_FILES) return;
		if (IGNORE.has(entry.name)) continue;

		const full = join(dir, entry.name);
		const rel = relative(root, full);

		if (entry.isDirectory()) {
			await walk(full, root, files);
		} else {
			files.push(rel);
		}
	}
}

const BASE_PROMPT = `You are Kodr, a coding assistant. You help developers by reading, writing, and modifying code in their workspace.

You have tools to interact with the filesystem. Use them to understand the codebase before making changes. Always read relevant files before editing them.

Guidelines:
- Read before you write. Understand the existing code structure.
- Make targeted changes. Don't rewrite files unnecessarily.
- Respect existing code style and conventions.
- When writing new files, match the patterns used in the project.
- If a task requires running commands (tests, builds), use the run_command tool.
- If a task matches an available skill, load it with load_skill and follow its instructions.
- Explain what you're doing and why.`;

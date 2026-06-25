/**
 * Skill discovery and loading.
 * A skill is a SKILL.md file with YAML frontmatter (name, description)
 * and a markdown body of instructions. Skills live under
 * .kodr/skills/<dir>/SKILL.md. Discovery surfaces the name and
 * description; the body is loaded on demand via the load_skill tool.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveExistingPath } from './path-jail.mjs';

const SKILLS_DIR = '.kodr/skills';

/**
 * List available skills in a workspace.
 * @param {string} cwd - Workspace root
 * @returns {Promise<Array<{name: string, description: string}>>}
 */
export async function discoverSkills(cwd) {
	const skills = await readAllSkills(cwd);
	return skills.map((s) => ({ name: s.name, description: s.description }));
}

/**
 * Load a single skill's full instructions by name.
 * Matches the frontmatter name, falling back to the directory name.
 * @param {string} cwd - Workspace root
 * @param {string} name - Skill name as listed by discoverSkills
 * @returns {Promise<{name: string, description: string, instructions: string}|null>}
 */
export async function loadSkill(cwd, name) {
	const skills = await readAllSkills(cwd);
	const skill = skills.find((s) => s.name === name);
	if (!skill) return null;
	return {
		name: skill.name,
		description: skill.description,
		instructions: skill.body,
	};
}

/**
 * Read and parse every skill in the workspace.
 * @param {string} cwd
 * @returns {Promise<Array<{name, description, body}>>}
 */
async function readAllSkills(cwd) {
	let dir;
	try {
		dir = await resolveExistingPath(cwd, SKILLS_DIR);
	} catch {
		return [];
	}
	if (!dir) return [];

	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const skills = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const skill = await readSkill(cwd, entry.name);
		if (skill) skills.push(skill);
	}
	return skills;
}

/**
 * Read and parse one skill directory's SKILL.md.
 * @param {string} cwd
 * @param {string} dirName - Skill directory name under .kodr/skills
 * @returns {Promise<{name, description, body}|null>}
 */
async function readSkill(cwd, dirName) {
	const rel = join(SKILLS_DIR, dirName, 'SKILL.md');

	let resolved;
	try {
		resolved = await resolveExistingPath(cwd, rel);
	} catch {
		return null;
	}
	if (!resolved) return null;

	let raw;
	try {
		raw = await readFile(resolved, 'utf8');
	} catch {
		return null;
	}

	const { frontmatter, body } = parseFrontmatter(raw);
	return {
		name: frontmatter.name || dirName,
		description: frontmatter.description || '',
		body,
	};
}

/**
 * Parse a leading YAML frontmatter block of simple key:value pairs.
 * Anything beyond the closing --- is the body.
 * @param {string} raw
 * @returns {{frontmatter: object, body: string}}
 */
export function parseFrontmatter(raw) {
	const text = raw.replace(/^\uFEFF/, '');
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
	if (!match) {
		return { frontmatter: {}, body: text.trim() };
	}

	const frontmatter = {};
	for (const line of match[1].split('\n')) {
		const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
		if (!pair) continue;
		frontmatter[pair[1]] = stripQuotes(pair[2].trim());
	}

	return { frontmatter, body: text.slice(match[0].length).trim() };
}

function stripQuotes(value) {
	if (value.length < 2) return value;
	const first = value[0];
	const last = value[value.length - 1];
	if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
		return value.slice(1, -1);
	}
	return value;
}

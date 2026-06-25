/**
 * Command permissions — gate run_command behind an exact-match allowlist.
 *
 * The allowlist persists at .kodr/allowed-commands.json. Commands on the list
 * run silently; unknown commands prompt the user (when a TTY is attached) or
 * are denied (when running non-interactively). Matching is exact: the stored
 * rule, the displayed rule, and the matched command are the same string.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { formatPermissionPrompt } from './format.mjs';

const ALLOW_FILE = ['.kodr', 'allowed-commands.json'];

/**
 * Read the persisted allowlist. Missing or malformed files are treated as empty.
 * @param {string} cwd - Workspace root
 * @returns {Promise<string[]>}
 */
export async function loadAllowedCommands(cwd) {
	try {
		const data = JSON.parse(await readFile(join(cwd, ...ALLOW_FILE), 'utf8'));
		if (Array.isArray(data.commands)) return data.commands;
	} catch {
		// missing or malformed — treat as empty
	}
	return [];
}

/**
 * Append a command to the persisted allowlist, de-duplicating.
 * @param {string} cwd - Workspace root
 * @param {string} command - Exact command to allow
 * @returns {Promise<string[]>} The updated list
 */
export async function addAllowedCommand(cwd, command) {
	const existing = await loadAllowedCommands(cwd);
	if (existing.includes(command)) return existing;
	const updated = [...existing, command];
	const file = join(cwd, ...ALLOW_FILE);
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, JSON.stringify({ commands: updated }, null, 2), 'utf8');
	return updated;
}

/**
 * Create a command gate bound to a workspace.
 * @param {object} options
 * @param {string} options.cwd - Workspace root
 * @param {boolean} [options.allowAll] - Bypass the gate entirely
 * @param {string[]} [options.seeded] - Commands allowed for this run only
 * @param {function} options.confirm - (command) => "once" | "always" | "deny"
 * @returns {Promise<{ check: (command: string) => Promise<{ allowed: boolean }> }>}
 */
export async function createCommandGate(options) {
	const { cwd, allowAll = false, seeded = [], confirm } = options;
	const allowed = new Set([...(await loadAllowedCommands(cwd)), ...seeded]);

	async function check(command) {
		if (allowAll) return { allowed: true };
		if (allowed.has(command)) return { allowed: true };

		const decision = await confirm(command);
		if (decision === 'deny') return { allowed: false };

		allowed.add(command);
		if (decision === 'always') await addAllowedCommand(cwd, command);
		return { allowed: true };
	}

	return { check };
}

/**
 * Map a typed answer to a decision.
 * @param {string} answer
 * @returns {"once" | "always" | "deny"}
 */
export function parseDecision(answer) {
	const a = (answer || '').trim().toLowerCase();
	if (a === 'y' || a === 'yes') return 'once';
	if (a === 'a' || a === 'always') return 'always';
	return 'deny';
}

/**
 * Build the confirm function used by the gate.
 * With no TTY, every unknown command is denied without reading input.
 * @param {object} io
 * @param {boolean} io.isTty - Whether stdin is interactive
 * @param {NodeJS.ReadableStream} io.input - Input stream (stdin)
 * @param {NodeJS.WritableStream} io.output - Output stream for the prompt
 * @returns {(command: string) => Promise<"once" | "always" | "deny">}
 */
export function createConfirm(io) {
	return async function confirm(command) {
		if (!io.isTty) return 'deny';
		const rl = createInterface({ input: io.input, output: io.output });
		try {
			const answer = await new Promise((resolve) => {
				rl.question(formatPermissionPrompt(command), resolve);
			});
			return parseDecision(answer);
		} finally {
			rl.close();
		}
	};
}

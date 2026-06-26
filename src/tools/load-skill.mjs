/**
 * load_skill tool — load a skill's full instructions by name.
 * Available skills are listed in the system prompt under <available-skills>.
 */

import { loadSkill } from '../skills.mjs';

export default {
	definition: {
		name: 'load_skill',
		description:
			'Load the full instructions for an available skill by name. Skills are listed in the system prompt under <available-skills>. When a task matches a skill, call this with the skill name, then follow the returned instructions.',
		parameters: {
			type: 'object',
			properties: {
				name: {
					type: 'string',
					description: 'The skill name as listed in <available-skills>',
				},
			},
			required: ['name'],
		},
	},

	async execute({ name }, context) {
		if (!name || typeof name !== 'string') {
			return { error: 'name is required' };
		}

		const skill = await loadSkill(context.cwd, name);
		if (!skill) {
			return { error: `unknown skill: ${name}` };
		}

		return {
			name: skill.name,
			description: skill.description,
			instructions: skill.instructions,
		};
	},
};

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { hasNoProgress, heal } from '../src/heal.mjs';

describe('healing', () => {
	it('detects identical consecutive failures as no progress', () => {
		assert.equal(hasNoProgress('same failure', 'same failure'), true);
		assert.equal(hasNoProgress('first failure', 'second failure'), false);
	});

	it('respects a zero-turn limit without calling the model', async () => {
		let modelCalled = false;
		const client = {
			async chat() {
				modelCalled = true;
				throw new Error('model must not be called');
			},
		};
		const verification = { passed: false, output: 'failure' };
		const result = await heal({
			client,
			modelId: 'unused',
			messages: [],
			tools: {},
			verifyFn: async () => verification,
			failure: verification,
			maxTurns: 0,
			quiet: true,
		});

		assert.equal(modelCalled, false);
		assert.equal(result.turns, 0);
		assert.equal(result.healed, false);
	});
});

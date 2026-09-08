import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  dispatchPrompt,
  resolveDispatchAgents,
  startAgentWorkers,
} from '../lib/hydra-operator.mjs';
import { _resetRegistry, initAgentRegistry } from '../lib/hydra-agents.mjs';
import { registerBuiltInSubAgents } from '../lib/hydra-sub-agents.mjs';

const runtimeConfig = {
  agents: {
    fallbacks: {
      gemini: ['claude', 'codex'],
      claude: ['codex'],
      codex: ['claude'],
    },
  },
};
const capabilityOpts = { availableAgents: ['claude', 'codex'] };

beforeEach(() => {
  _resetRegistry();
  initAgentRegistry();
  registerBuiltInSubAgents();
});

describe('real handoff participant path', () => {
  it('creates no Gemini handoff when Gemini is unavailable', async () => {
    const requests = [];
    const records = await dispatchPrompt({
      baseUrl: 'http://hydra.test',
      from: 'human',
      agents: ['gemini', 'codex', 'claude'],
      promptText: 'Analyze repository architecture. Do not modify files.',
      runtimeConfig,
      capabilityOpts,
      requestFn: async (method, baseUrl, route, payload) => {
        requests.push({ method, baseUrl, route, payload });
        return { handoff: { id: `H00${requests.length}`, ...payload } };
      },
    });

    assert.deepEqual(records.map((record) => record.agent), ['claude', 'codex']);
    assert.deepEqual(requests.map((call) => call.payload.to), ['claude', 'codex']);
    assert.equal(requests.some((call) => call.payload.to === 'gemini'), false);
  });

  it('starts no Gemini worker and starts Claude + Codex from created records', async () => {
    const records = await dispatchPrompt({
      baseUrl: 'http://hydra.test',
      from: 'human',
      agents: ['gemini', 'codex', 'claude'],
      promptText: 'Analyze repository architecture. Do not modify files.',
      runtimeConfig,
      capabilityOpts,
      requestFn: async (_method, _baseUrl, _route, payload) => ({
        handoff: { id: `H-${payload.to}`, ...payload },
      }),
    });
    const started = [];
    const resolved = startAgentWorkers(
      records.map((record) => record.agent),
      'http://hydra.test',
      {
        runtimeConfig,
        capabilityOpts,
        startWorkerFn: (agent) => started.push(agent),
      },
    );

    assert.deepEqual(resolved, ['claude', 'codex']);
    assert.deepEqual(started, ['claude', 'codex']);
    assert.equal(started.includes('gemini'), false);
  });

  it('resolves virtual agents before handoff or worker creation', () => {
    assert.deepEqual(
      resolveDispatchAgents(['researcher', 'test-writer', 'gemini'], {
        runtimeConfig,
        capabilityOpts,
      }),
      ['claude', 'codex'],
    );
  });
});

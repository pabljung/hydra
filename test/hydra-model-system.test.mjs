import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

import {
  detectInstalledCLIs,
  resolveAvailableAgent,
} from '../lib/hydra-capabilities.mjs';
import { parseCodexModelCatalog, parseCodexModelCapabilities } from '../lib/hydra-models.mjs';
import {
  _resetRegistry,
  getAgent,
  initAgentRegistry,
  resolveModelId,
} from '../lib/hydra-agents.mjs';
import { registerBuiltInSubAgents } from '../lib/hydra-sub-agents.mjs';
import { mergeWithDefaults } from '../lib/hydra-config.mjs';
import { buildCliInvocation, isSafeModelId, spawnCliInvocation } from '../lib/hydra-shared/agent-executor.mjs';
import { resolveCouncilAgents, resolveCouncilFlow, synthesizeCouncilTranscript } from '../lib/hydra-council.mjs';

beforeEach(() => {
  _resetRegistry();
  initAgentRegistry();
});

describe('installed CLI capabilities', () => {
  it('supports Claude + Codex with Gemini absent', () => {
    const installed = detectInstalledCLIs({
      installed: { claude: true, codex: true, gemini: false },
    });
    assert.deepEqual(installed, { claude: true, gemini: false, codex: true });

    const resolved = resolveAvailableAgent('gemini', {}, {
      availableAgents: ['claude', 'codex'],
    });
    assert.equal(resolved, 'claude');
  });

  it('honors an explicit agent fallback chain', () => {
    const config = { agents: { fallbacks: { gemini: ['codex', 'claude'] } } };
    assert.equal(resolveAvailableAgent('gemini', config, {
      availableAgents: ['claude', 'codex'],
    }), 'codex');
  });

  it('removes unavailable and duplicate council backends', () => {
    const agents = resolveCouncilAgents(undefined, {}, {
      availableAgents: ['claude', 'codex'],
    });
    assert.deepEqual(agents, ['claude', 'codex']);
  });

  it('resolves every sequential council phase when Gemini is absent', () => {
    const flow = resolveCouncilFlow([
      { agent: 'claude', phase: 'propose' },
      { agent: 'gemini', phase: 'critique' },
      { agent: 'codex', phase: 'implement' },
    ], {}, { availableAgents: ['claude', 'codex'] });
    assert.deepEqual(flow.map(({ requestedAgent, agent, phase }) => ({ requestedAgent, agent, phase })), [
      { requestedAgent: 'claude', agent: 'claude', phase: 'propose' },
      { requestedAgent: 'gemini', agent: 'claude', phase: 'critique' },
      { requestedAgent: 'codex', agent: 'codex', phase: 'implement' },
    ]);
  });

  it('does not assign fallback council tasks to absent Gemini by default', () => {
    const synthesis = synthesizeCouncilTranscript('validate routing', []);
    assert.deepEqual(synthesis.tasks.map((task) => task.owner), ['claude', 'claude', 'codex']);
  });
});

describe('model discovery and permissive selection', () => {
  it('parses the structured Codex catalog in priority order', () => {
    const models = parseCodexModelCatalog(JSON.stringify({ models: [
      { slug: 'future-custom-model', visibility: 'list', priority: 9 },
      { slug: 'hidden-internal', visibility: 'hide', priority: 1 },
      { slug: 'gpt-6-astra', visibility: 'list', priority: 2 },
    ] }));
    assert.deepEqual(models, ['gpt-6-astra', 'future-custom-model']);
  });

  it('uses the catalog reasoning levels instead of a name-based guess', () => {
    const capabilities = parseCodexModelCapabilities(JSON.stringify({ models: [{
      slug: 'future-custom-model',
      visibility: 'list',
      default_reasoning_level: 'medium',
      supported_reasoning_levels: [
        { effort: 'low', description: 'fast' },
        { effort: 'ultra', description: 'deep' },
      ],
    }] }));
    assert.deepEqual(capabilities['future-custom-model'], {
      defaultReasoningEffort: 'medium',
      reasoningEfforts: [
        { id: 'low', description: 'fast' },
        { id: 'ultra', description: 'deep' },
      ],
    });
  });

  it('passes unknown model IDs through unchanged', () => {
    assert.equal(resolveModelId('codex', 'future-model-2030'), 'future-model-2030');
    assert.equal(resolveModelId('claude', 'vendor/custom_model:v2'), 'vendor/custom_model:v2');
  });

  it('resolves current convenience aliases without changing explicit IDs', () => {
    assert.equal(resolveModelId('codex', 'sol'), 'gpt-5.6-sol');
    assert.equal(resolveModelId('claude', 'sonnet'), 'sonnet');
    assert.equal(resolveModelId('codex', 'gpt-5.6-sol'), 'gpt-5.6-sol');
  });

  it('accepts shell-safe custom IDs and rejects control characters', () => {
    assert.equal(isSafeModelId('provider/custom_model:v2'), true);
    assert.equal(isSafeModelId('model\n--dangerous'), false);
  });
});

describe('headless and worker invocation', () => {
  it('sends a new Codex ID and current reasoning config without an allowlist', () => {
    const invocation = buildCliInvocation('codex', 'test prompt', {
      cwd: 'C:/work',
      modelOverride: 'future-model-2030',
      reasoningEffort: 'high',
      permissionMode: 'read-only',
    });
    assert.equal(invocation.cmd, 'codex');
    assert.deepEqual(invocation.args.slice(0, 4), ['exec', '-', '--sandbox', 'read-only']);
    assert.ok(invocation.args.includes('future-model-2030'));
    assert.ok(invocation.args.includes('model_reasoning_effort="high"'));
    assert.ok(!invocation.args.includes('--reasoning-effort'));
  });

  it('uses the current Codex auto-edit flag and exact TOML reasoning value', () => {
    const invocation = buildCliInvocation('codex', 'test prompt', {
      cwd: 'C:/work',
      modelOverride: 'gpt-5.6-sol',
      reasoningEffort: 'high',
      permissionMode: 'auto-edit',
    });
    assert.deepEqual(invocation.args, [
      'exec', '-', '--approve-for-me',
      '-C', 'C:/work',
      '--model', 'gpt-5.6-sol',
      '--config', 'model_reasoning_effort="high"',
      '--json',
    ]);
    assert.equal(invocation.args.includes('--full-auto'), false);
  });

  it('reserves the current unrestricted Codex flag for explicit full-auto mode', () => {
    const invocation = buildCliInvocation('codex', 'test prompt', {
      permissionMode: 'full-auto',
    });
    assert.ok(invocation.args.includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.equal(invocation.args.includes('--approve-for-me'), false);
  });

  it('spawns a portable direct argv with shell disabled', async () => {
    const invocation = {
      cmd: process.execPath,
      args: ['-e', 'process.stdout.write("portable-spawn-ok")'],
    };
    const child = spawnCliInvocation(invocation, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    const [code] = await once(child, 'close');
    assert.equal(code, 0);
    assert.equal(stdout, 'portable-spawn-ok');
  });

  it('sends the effective Claude alias shown by Hydra', () => {
    const invocation = buildCliInvocation('claude', 'test prompt', {});
    const modelIndex = invocation.args.indexOf('--model');
    assert.equal(invocation.args[modelIndex + 1], 'opus');
  });

  it('lets an unconfigured optional Gemini installation use its CLI default', () => {
    const invocation = buildCliInvocation('gemini', 'test prompt', {});
    assert.equal(invocation.cmd, 'gemini');
    assert.equal(invocation.args.includes('--model'), false);
  });
});

describe('defaults and explicit configuration', () => {
  it('keeps the generated Codex default independent from the active user config', () => {
    assert.equal(mergeWithDefaults({}).models.codex.default, 'gpt-6-astra');
  });

  it('preserves explicit user model, alias, role, and recommendation values', () => {
    const merged = mergeWithDefaults({
      models: { codex: { default: 'my-default', active: 'my-selected' } },
      aliases: { codex: { mine: 'vendor/custom-v9' } },
      roles: { analyst: { agent: 'gemini', model: 'user-model' } },
      recommendations: { analyst: { models: ['user-model'], note: 'user choice' } },
    });
    assert.equal(merged.models.codex.default, 'my-default');
    assert.equal(merged.models.codex.active, 'my-selected');
    assert.equal(merged.aliases.codex.mine, 'vendor/custom-v9');
    assert.equal(merged.roles.analyst.agent, 'gemini');
    assert.equal(merged.roles.analyst.model, 'user-model');
    assert.deepEqual(merged.recommendations.analyst.models, ['user-model']);
    assert.equal(merged.recommendations.analyst.note, 'user choice');
  });

  it('maps essential virtual agents to Claude or Codex by default', () => {
    registerBuiltInSubAgents();
    assert.equal(getAgent('security-reviewer').baseAgent, 'claude');
    assert.equal(getAgent('researcher').baseAgent, 'claude');
    assert.equal(getAgent('evolve-researcher').baseAgent, 'claude');
    assert.equal(getAgent('failure-doctor').baseAgent, 'claude');
    assert.equal(getAgent('test-writer').baseAgent, 'codex');
    assert.equal(getAgent('doc-generator').baseAgent, 'claude');
  });
});

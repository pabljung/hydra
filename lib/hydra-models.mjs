#!/usr/bin/env node
/**
 * Hydra Model Discovery — List all available models per agent.
 *
 * Strategy per agent (tries in order, stops at first success):
 *   1. Use a structured CLI catalog when the installed CLI exposes one
 *   2. Hit the provider REST API when an API key is available
 *   3. Show Hydra-configured models (always available, incomplete)
 *
 * Usage:
 *   node lib/hydra-models.mjs               # all agents
 *   node lib/hydra-models.mjs claude         # one agent
 *   node lib/hydra-models.mjs codex
 *   node lib/hydra-models.mjs gemini
 *
 * npm scripts:
 *   npm run models                           # all
 *   npm run models -- claude                 # single
 */

import https from 'https';
import path from 'path';
import spawn from 'cross-spawn';
import { loadHydraConfig } from './hydra-config.mjs';
import { getActiveModel, getReasoningEffort, getEffortOptionsForModel, AGENT_NAMES, AGENTS } from './hydra-agents.mjs';
import pc from 'picocolors';

// ── HTTP helper ─────────────────────────────────────────────────────────────

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { headers, timeout: 10_000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Bad JSON from API`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// ── Strategy 1: REST API with env key ───────────────────────────────────────

async function apiClaude() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const data = await httpGet('https://api.anthropic.com/v1/models?limit=100', {
    'x-api-key': key, 'anthropic-version': '2023-06-01',
  });
  return (data.data || []).map((m) => m.id).sort();
}

async function apiCodex() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const data = await httpGet('https://api.openai.com/v1/models', {
    'Authorization': `Bearer ${key}`,
  });
  return (data.data || []).map((m) => m.id).sort();
}

async function apiGemini() {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) return null;
  const data = await httpGet(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${key}&pageSize=200`
  );
  return (data.models || []).map((m) => m.name.replace('models/', '')).sort();
}

// ── Structured CLI discovery ────────────────────────────────────────────────

function parseCodexCatalogObject(raw) {
  if (!raw) return [];
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return Array.isArray(parsed?.models) ? parsed.models : [];
}

/** Parse visible model IDs from the JSON contract emitted by `codex debug models`. */
export function parseCodexModelCatalog(raw) {
  return parseCodexCatalogObject(raw)
    .filter((model) => model?.slug && model.visibility !== 'hide')
    .sort((a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER))
    .map((model) => model.slug);
}

/** Parse per-model reasoning levels without guessing from the model name. */
export function parseCodexModelCapabilities(raw) {
  return Object.fromEntries(parseCodexCatalogObject(raw)
    .filter((model) => model?.slug && model.visibility !== 'hide')
    .map((model) => [model.slug, {
      defaultReasoningEffort: model.default_reasoning_level || null,
      reasoningEfforts: (model.supported_reasoning_levels || [])
        .map((entry) => ({ id: entry?.effort, description: entry?.description || '' }))
        .filter((entry) => entry.id),
    }]));
}

function cliCodex() {
  const result = spawn.sync('codex', ['debug', 'models'], {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 5 * 1024 * 1024,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0 || !result.stdout) return null;
  const models = parseCodexModelCatalog(result.stdout);
  return models.length > 0
    ? { models, capabilities: parseCodexModelCapabilities(result.stdout) }
    : null;
}

// ── Orchestrate per agent ───────────────────────────────────────────────────

const STRATEGIES = {
  claude: { api: apiClaude },
  codex:  { api: apiCodex, cli: cliCodex, cliFirst: true },
  gemini: { api: apiGemini },
};

export async function fetchModels(agentName) {
  const strat = STRATEGIES[agentName];
  if (!strat) return { models: [], source: 'none' };

  // Codex exposes an authenticated, structured catalog through the installed CLI.
  if (strat.cliFirst && strat.cli) {
    try {
      const discovered = strat.cli();
      if (discovered?.models?.length > 0) return { ...discovered, source: 'cli' };
    } catch { /* fall through */ }
  }

  // Try the provider API when a key is available.
  try {
    const models = await strat.api();
    if (models && models.length > 0) return { models, source: 'api' };
  } catch { /* fall through */ }

  // No stable structured catalog is exposed by this CLI version. In particular,
  // do not ask a language model to guess the catalog and parse its prose.
  return { models: [], source: 'config-only' };
}

// ── Display ─────────────────────────────────────────────────────────────────

function displayAgent(agentName, fetchResult) {
  const cfg = loadHydraConfig();
  const agentModels = cfg.models?.[agentName] || {};
  const aliases = cfg.aliases?.[agentName] || {};
  const activeModel = getActiveModel(agentName);
  const agentInfo = AGENTS[agentName];
  const mode = cfg.mode || 'performance';
  const tierPreset = cfg.modeTiers?.[mode]?.[agentName] || 'default';

  console.log('');
  console.log(pc.bold(pc.cyan(`═══ ${agentInfo?.label || agentName} ═══`)));

  // Active model + reasoning effort
  const effort = getReasoningEffort(agentName);
  const effortStr = effort ? pc.yellow(` [${effort}]`) : '';
  console.log(`  Active:  ${pc.green(activeModel || 'CLI default')}${effortStr} ${pc.dim(`(mode: ${mode} → ${tierPreset})`)}`);

  // Presets
  const presetKeys = ['default', 'fast', 'cheap'];
  console.log(pc.bold('  Presets:'));
  for (const key of presetKeys) {
    if (agentModels[key]) {
      const marker = agentModels[key] === activeModel ? pc.green(' ◀') : '';
      console.log(`    ${pc.dim(key.padEnd(8))} ${agentModels[key]}${marker}`);
    }
  }

  // Reasoning effort
  console.log(pc.bold('  Effort:'));
  const catalogEfforts = fetchResult.capabilities?.[activeModel]?.reasoningEfforts?.map((entry) => entry.id);
  const effortLevels = catalogEfforts?.length
    ? catalogEfforts
    : getEffortOptionsForModel(activeModel).map((entry) => entry.id).filter(Boolean);
  const effortLine = effortLevels.map((e) =>
    e === effort ? pc.green(e) + pc.green(' ◀') : pc.dim(e)
  ).join('  ');
  console.log(`    ${effort ? effortLine : effortLevels.length ? `${pc.dim('default')}  (${effortLevels.map(e => pc.dim(e)).join(' | ')})` : pc.dim('CLI default')}`);

  // Aliases
  if (Object.keys(aliases).length > 0) {
    console.log(pc.bold('  Aliases:'));
    for (const [alias, modelId] of Object.entries(aliases)) {
      console.log(`    ${pc.dim(alias.padEnd(12))} → ${modelId}`);
    }
  }

  // Discovered models
  const { models, source } = fetchResult;
  const sourceLabel = source === 'api' ? 'REST API' : source === 'cli' ? 'CLI query' : 'config only';

  if (models.length === 0) {
    console.log(pc.bold(`  Available Models ${pc.dim(`(${sourceLabel})`)}:`));
    console.log(pc.yellow('    Set API key in env for full list, or use CLI aliases above'));
    console.log(pc.dim(`    Claude: ANTHROPIC_API_KEY  |  Codex: OPENAI_API_KEY  |  Gemini: GEMINI_API_KEY`));
    return;
  }

  // Build known-set for highlighting
  const knownIds = new Set();
  for (const key of presetKeys) {
    if (agentModels[key]) knownIds.add(agentModels[key]);
  }
  for (const modelId of Object.values(aliases)) knownIds.add(modelId);

  console.log(pc.bold(`  Available Models (${models.length}) ${pc.dim(`[${sourceLabel}]`)}:`));
  for (const model of models) {
    const isActive = model === activeModel;
    const isConfigured = knownIds.has(model);
    if (isActive) {
      console.log(`    ${pc.green(model)} ${pc.green('◀ active')}`);
    } else if (isConfigured) {
      console.log(`    ${pc.blue(model)} ${pc.dim('(configured)')}`);
    } else {
      console.log(`    ${model}`);
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const arg = process.argv[2]?.toLowerCase();

  const agents = arg && AGENT_NAMES.includes(arg)
    ? [arg]
    : AGENT_NAMES;

  if (arg && !AGENT_NAMES.includes(arg)) {
    console.error(pc.red(`Unknown agent: ${arg}`));
    console.error(`Available: ${AGENT_NAMES.join(', ')}`);
    process.exit(1);
  }

  console.log(pc.bold('Discovering models...'));

  // Fetch all in parallel
  const results = {};
  await Promise.all(agents.map(async (agent) => {
    results[agent] = await fetchModels(agent);
  }));

  for (const agent of agents) {
    displayAgent(agent, results[agent]);
  }

  console.log('');
}

// Only run when invoked directly (not when imported by hydra-models-select.mjs)
const __self = new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const __argv1 = path.resolve(process.argv[1] || '');
if (__argv1 === path.resolve(__self)) {
  main().catch((err) => {
    console.error(pc.red(`Error: ${err.message}`));
    process.exit(1);
  });
}

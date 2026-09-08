/**
 * Runtime capability detection for CLI-backed agents.
 *
 * Availability is deliberately separate from model policy: Hydra may route to any
 * configured model ID, while this module only answers whether an execution backend
 * can be started on the current machine.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import crossSpawn from 'cross-spawn';

const availabilityCache = new Map();

/** Check whether an executable is currently reachable on PATH. */
export function commandExists(command, opts = {}) {
  if (!command || typeof command !== 'string') return false;
  if (opts.installed && Object.hasOwn(opts.installed, command)) {
    return Boolean(opts.installed[command]);
  }
  if (!opts.refresh && availabilityCache.has(command)) {
    return availabilityCache.get(command);
  }

  let available = false;
  try {
    const locator = process.platform === 'win32' ? 'where' : 'which';
    const result = crossSpawn.sync(locator, [command], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    available = result.status === 0 && Boolean((result.stdout || '').trim());
  } catch {
    available = false;
  }
  availabilityCache.set(command, available);
  return available;
}

/** Detect the three supported first-party CLIs without requiring all of them. */
export function detectInstalledCLIs(opts = {}) {
  return {
    claude: commandExists('claude', opts),
    gemini: commandExists('gemini', opts),
    codex: commandExists('codex', opts),
  };
}

/** Gemini's direct transport can work from its existing OAuth cache without its CLI. */
export function hasGeminiOAuthCredentials(opts = {}) {
  const home = opts.homeDir || os.homedir();
  const exists = opts.exists || fs.existsSync;
  return exists(path.join(home, '.gemini', 'oauth_creds.json'));
}

/**
 * Return whether an agent has a usable local execution backend.
 * Tests may pass `availableAgents` to avoid depending on the host PATH.
 */
export function isAgentAvailable(agentName, config = {}, opts = {}) {
  const name = String(agentName || '').toLowerCase();
  if (opts.availableAgents) return opts.availableAgents.includes(name);

  if (name === 'claude' || name === 'codex') {
    return commandExists(name, opts);
  }
  if (name === 'gemini') {
    // Participant routing is based on installed physical CLIs. A stale OAuth
    // cache must not cause Hydra to create Gemini work without a Gemini CLI.
    // Credential-only execution remains available as an explicit opt-in for
    // callers that intentionally use the direct transport.
    return commandExists('gemini', opts)
      || (opts.allowCredentialOnly === true && hasGeminiOAuthCredentials(opts));
  }
  if (name === 'local') {
    return config.local?.enabled === true;
  }

  const custom = config.agents?.customAgents?.find((entry) => entry?.name === name);
  if (!custom) return false;
  if (custom.type === 'api') return Boolean(custom.baseUrl);
  if (custom.type === 'cli') {
    return commandExists(custom.invoke?.headless?.cmd || name, opts);
  }
  return false;
}

/** Ordered physical agents that can execute on this machine. */
export function getAvailableAgentNames(config = {}, opts = {}) {
  const builtIns = ['claude', 'codex', 'gemini', 'local'];
  const custom = (config.agents?.customAgents || []).map((entry) => entry?.name).filter(Boolean);
  return [...new Set([...builtIns, ...custom])]
    .filter((name) => isAgentAvailable(name, config, opts));
}

/**
 * Resolve a preferred agent through a configurable fallback chain.
 * Explicit chains win; defaults make a Claude + Codex installation complete.
 */
export function resolveAvailableAgent(preferred, config = {}, opts = {}) {
  const name = String(preferred || '').toLowerCase();
  if (isAgentAvailable(name, config, opts)) return name;

  const defaults = {
    gemini: ['claude', 'codex'],
    claude: ['codex', 'gemini'],
    codex: ['claude', 'gemini'],
    local: ['codex', 'claude', 'gemini'],
  };
  const configured = config.agents?.fallbacks?.[name];
  const candidates = Array.isArray(configured) ? configured : (defaults[name] || ['claude', 'codex', 'gemini']);
  return candidates.find((candidate) => isAgentAvailable(candidate, config, opts)) || null;
}

/**
 * Resolve a participant list to installed physical execution backends.
 * Resolution and de-duplication happen before callers create tasks, handoffs,
 * UI records, or workers. A virtual-agent resolver may be supplied by callers
 * without coupling this module to the agent registry.
 */
export function resolveAvailableAgentNames(preferredAgents, config = {}, opts = {}) {
  const resolvePhysical = typeof opts.resolvePhysicalAgent === 'function'
    ? opts.resolvePhysicalAgent
    : null;
  const resolved = [];

  for (const requested of Array.isArray(preferredAgents) ? preferredAgents : []) {
    const requestedName = String(requested || '').trim().toLowerCase();
    if (!requestedName) continue;
    const physicalName = resolvePhysical?.(requestedName)?.name || requestedName;
    const available = resolveAvailableAgent(physicalName, config, opts);
    if (available && !resolved.includes(available)) resolved.push(available);
  }

  return resolved;
}

export function invalidateCapabilityCache() {
  availabilityCache.clear();
}

import { AGENT_ALIASES } from './constants';
import { deepMerge } from './merge';
import type { AgentOverrideConfig } from './schema';

export function canonicalizeAgentKeys(
  layer: Record<string, AgentOverrideConfig>,
): Record<string, AgentOverrideConfig> {
  const out: Record<string, AgentOverrideConfig> = {};
  for (const [name, value] of Object.entries(layer)) {
    const canonical = AGENT_ALIASES[name] ?? name;
    const existing = out[canonical];
    // Canonical spelling wins when one layer carries both spellings.
    out[canonical] =
      existing === undefined || name === canonical
        ? value
        : (deepMerge(existing, value) ?? existing);
  }
  return out;
}

/** Existing preset/root precedence, including explicit model inheritance. */
export function mergeAgentOverrides(
  base: Record<string, AgentOverrideConfig>,
  override: Record<string, AgentOverrideConfig>,
): Record<string, AgentOverrideConfig> {
  const merged =
    deepMerge(canonicalizeAgentKeys(base), canonicalizeAgentKeys(override)) ??
    base;
  for (const [name, agentOverride] of Object.entries(override)) {
    if (
      agentOverride.model !== undefined ||
      agentOverride.inheritModelFrom === undefined
    ) {
      continue;
    }
    const resolvedName = AGENT_ALIASES[name] ?? name;
    if (resolvedName !== name && Object.hasOwn(override, resolvedName)) {
      continue;
    }
    const entry = merged[resolvedName] ?? merged[name];
    if (entry) {
      const updatedEntry = { ...entry };
      delete updatedEntry.model;
      if (resolvedName !== name) {
        updatedEntry.inheritModelFrom = agentOverride.inheritModelFrom;
      }
      merged[resolvedName] = updatedEntry;
    }
  }
  return merged;
}

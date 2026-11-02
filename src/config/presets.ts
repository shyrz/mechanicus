import { AGENT_ALIASES } from './constants';
import { deepMerge } from './merge';
import type { Preset, PresetDefinition, PresetInput } from './schema';
import { PresetAgentsSchema } from './schema';

export type PresetMap = Record<string, PresetInput>;

export class PresetResolutionError extends Error {
  constructor(
    readonly kind: 'missing-parent' | 'cycle',
    readonly chain: readonly string[],
  ) {
    super(
      kind === 'missing-parent'
        ? `Preset parent not found (chain: ${chain.join(' -> ')})`
        : `Preset inheritance cycle detected: ${chain.join(' -> ')}`,
    );
    this.name = 'PresetResolutionError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function aliasFor(name: string): string {
  return own(AGENT_ALIASES, name) ?? name;
}

/** User-controlled names must never mutate a result object's prototype. */
function setOwn<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/** Convert structured and inline syntax without breaking legacy agent names. */
export function normalizePreset(input: PresetInput): PresetDefinition {
  if (
    isRecord(input) &&
    isRecord(input.agents) &&
    (input.extends === undefined || typeof input.extends === 'string')
  ) {
    if (PresetAgentsSchema.safeParse(input.agents).success) {
      const { agents, extends: parent, ...inline } = input;
      return {
        agents:
          Object.keys(inline).length > 0
            ? mergeAgentLayers(inline as Preset, agents as Preset)
            : (agents as Preset),
        ...(typeof parent === 'string' ? { extends: parent } : {}),
      };
    }
  }
  const agents = Object.fromEntries(
    Object.entries(input).filter(
      ([name]) => name !== 'extends' || typeof input.extends !== 'string',
    ),
  ) as Preset;
  return {
    agents,
    ...(typeof input.extends === 'string' ? { extends: input.extends } : {}),
  };
}

function canonicalize(agents: Preset): Preset {
  const result: Preset = {};
  // Canonical entries are applied after every alias, irrespective of order.
  for (const pass of ['alias', 'canonical'] as const) {
    for (const [name, override] of Object.entries(agents)) {
      const canonical = aliasFor(name);
      if ((pass === 'alias') !== (canonical !== name)) continue;
      setOwn(
        result,
        canonical,
        deepMerge(own(result, canonical), override) ?? override,
      );
    }
  }
  return result;
}

/** Merge fields, retaining an explicit request to inherit a model instead. */
export function mergeAgentLayers(base: Preset, override: Preset): Preset {
  const merged = deepMerge(canonicalize(base), canonicalize(override)) ?? {};
  const mergedCanonical = new Set<string>();
  for (const [name, entry] of Object.entries(override)) {
    const canonical = aliasFor(name);
    if (mergedCanonical.has(canonical)) continue;
    mergedCanonical.add(canonical);
    const inherited =
      canonical !== name &&
      override[canonical]?.model === undefined &&
      override[canonical]?.inheritModelFrom !== undefined;
    const effective = own(override, canonical) ?? entry;
    if (
      !inherited &&
      (effective.model !== undefined ||
        effective.inheritModelFrom === undefined)
    ) {
      continue;
    }
    const target = own(merged, canonical);
    if (target) {
      const next = { ...target };
      delete next.model;
      setOwn(merged, canonical, next);
    }
  }
  return merged;
}

/** Merge user/project declarations before expanding their parent chain. */
export function mergePresetMaps(
  base?: PresetMap,
  override?: PresetMap,
): PresetMap | undefined {
  if (!base) return override;
  if (!override) return base;
  const result = { ...base };
  for (const [name, input] of Object.entries(override)) {
    const previous = own(base, name);
    if (!previous) {
      setOwn(result, name, input);
      continue;
    }
    const a = normalizePreset(previous);
    const b = normalizePreset(input);
    if (
      !a.extends &&
      !b.extends &&
      !('agents' in previous || 'agents' in input)
    ) {
      setOwn(result, name, deepMerge(previous, input) ?? input);
      continue;
    }
    const merged = mergeAgentLayers(a.agents, b.agents);
    const parent = b.extends ?? a.extends;
    const structured =
      ('agents' in input &&
        PresetAgentsSchema.safeParse(input.agents).success) ||
      ('agents' in previous &&
        PresetAgentsSchema.safeParse(previous.agents).success);
    setOwn(
      result,
      name,
      structured || parent
        ? { agents: merged, ...(parent ? { extends: parent } : {}) }
        : ({
            ...merged,
            ...(parent ? { extends: parent } : {}),
          } as PresetInput),
    );
  }
  return result;
}

export function resolvePreset(name: string, presets: PresetMap): Preset {
  const resolved = new Map<string, Preset>();
  const visiting = new Set<string>();
  const stack: string[] = [];
  const visit = (current: string): Preset => {
    const cached = resolved.get(current);
    if (cached) return cached;
    if (visiting.has(current)) {
      throw new PresetResolutionError('cycle', [
        ...stack.slice(stack.indexOf(current)),
        current,
      ]);
    }
    const declaration = own(presets, current);
    if (!declaration) {
      throw new PresetResolutionError('missing-parent', [...stack, current]);
    }
    visiting.add(current);
    stack.push(current);
    try {
      const definition = normalizePreset(declaration);
      const agents = definition.extends
        ? mergeAgentLayers(visit(definition.extends), definition.agents)
        : definition.agents;
      resolved.set(current, agents);
      return agents;
    } finally {
      stack.pop();
      visiting.delete(current);
    }
  };
  return visit(name);
}

export function tryResolvePreset(
  name: string | undefined,
  presets: PresetMap | undefined,
): Preset | undefined {
  if (!name || !presets || !own(presets, name)) return undefined;
  try {
    return resolvePreset(name, presets);
  } catch (error) {
    if (error instanceof PresetResolutionError) return undefined;
    throw error;
  }
}

import * as fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type {
  AgentOverrideConfig,
  PluginConfig,
  Preset,
  PresetInput,
} from '../config';
import { AGENT_ALIASES } from '../config/constants';
import { mutateJsonConfigFile, parseJsonConfigText } from '../config/json-file';
import { findPluginConfigPaths } from '../config/loader';
import {
  mergePresetMaps,
  normalizePreset,
  resolvePreset,
} from '../config/presets';
import { PresetSchema } from '../config/schema';

/**
 * Result of a preset switch attempt. `message` is user-facing and intended for
 * a TUI toast/dialog (it is never injected into the LLM context).
 */
export interface PresetSwitchResult {
  ok: boolean;
  presetName: string;
  message: string;
  /** Per-agent summary lines, e.g. "orchestrator → model: x, variant: y". */
  summary: string[];
}

/** A flattened, SDK-shaped agent override derived from a preset entry. */
export interface AgentUpdate {
  model?: string;
  temperature?: number;
  variant?: string;
  options?: Record<string, unknown>;
}

/**
 * Switch the active preset purely through on-disk state: persist the preset
 * name to the user config file. The sidebar snapshot is deliberately NOT
 * touched — the new preset applies on the next reload/restart, when
 * `loadPluginConfig` re-reads the config file and merges the preset into
 * `config.agents`. Refreshing the sidebar mid-session while the agent
 * registry is unchanged would show models that don't match the running
 * agents, which is confusing.
 *
 * This is the shared core used by the TUI `/preset` slash command. It
 * deliberately does NOT touch OpenCode's in-memory agent registry. It also
 * does not set the server-side runtime-preset singleton, because the TUI
 * runs in a separate process from the server and cannot reach that state.
 */
export function switchPresetOnDisk(
  directory: string,
  presetName: string,
  config: PluginConfig,
): PresetSwitchResult {
  const presets = config.presets ?? {};
  let preset: Preset | undefined;
  const known = Object.hasOwn(presets, presetName);
  try {
    preset = known ? resolvePreset(presetName, presets) : undefined;
  } catch (error) {
    if (error instanceof Error && error.name === 'PresetResolutionError') {
      return {
        ok: false,
        presetName,
        message: error.message,
        summary: [],
      };
    }
    const available = Object.keys(presets);
    const hint =
      available.length > 0
        ? `Available presets: ${available.join(', ')}`
        : 'No presets configured. Define presets in mechanicus.jsonc.';
    return {
      ok: false,
      presetName,
      message: `Preset "${presetName}" not found. ${hint}`,
      summary: [],
    };
  }

  if (!preset) {
    const available = Object.keys(presets);
    const hint =
      available.length > 0
        ? `Available presets: ${available.join(', ')}`
        : 'No presets configured. Define presets in mechanicus.jsonc.';
    return {
      ok: false,
      presetName,
      message: `Preset "${presetName}" not found. ${hint}`,
      summary: [],
    };
  }
  const agentUpdates = buildAgentUpdates(preset);
  if (
    !Object.values(preset).some((override) => Object.keys(override).length > 0)
  ) {
    return {
      ok: false,
      presetName,
      message: `Preset "${presetName}" is empty (no agent overrides defined).`,
      summary: [],
    };
  }

  try {
    const envPreset = process.env.MECHANICUS_PRESET;
    const { projectConfigPath } = findPluginConfigPaths(directory);
    const projectPreset = projectConfigPath
      ? parseJsonConfigText(fs.readFileSync(projectConfigPath, 'utf8')).preset
      : undefined;
    if (envPreset && envPreset !== presetName) {
      throw new Error(
        `MECHANICUS_PRESET selects "${envPreset}" and takes precedence. Update or unset it first.`,
      );
    }
    if (typeof projectPreset === 'string' && projectPreset !== presetName) {
      throw new Error(
        `Project config selects "${projectPreset}" and takes precedence. Edit its preset field first.`,
      );
    }
    persistPresetName(directory, presetName);
  } catch (error) {
    return {
      ok: false,
      presetName,
      message: `Preset "${presetName}" was not saved: ${error instanceof Error ? error.message : String(error)}`,
      summary: [],
    };
  }

  return {
    ok: true,
    presetName,
    message: `Saved preset "${presetName}". Reload OpenCode (or start a new conversation) for it to take effect. The current session keeps its existing agent models to avoid truncating context, drifting prior turns, or destabilizing running subagents.`,
    summary: buildPresetSummary(agentUpdates),
  };
}

/**
 * Build the SDK-shaped agent overrides from a preset, resolving legacy alias
 * keys (e.g. "explore" → "magos").
 */
export function buildAgentUpdates(preset: Preset): Record<string, AgentUpdate> {
  const agentUpdates: Record<string, AgentUpdate> = {};
  for (const [agentName, override] of Object.entries(preset)) {
    const resolvedName = Object.hasOwn(AGENT_ALIASES, agentName)
      ? AGENT_ALIASES[agentName]
      : agentName;
    const agentConfig = mapOverrideToAgentConfig(override);
    if (Object.keys(agentConfig).length > 0) {
      Object.defineProperty(agentUpdates, resolvedName, {
        value: agentConfig,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    }
  }
  return agentUpdates;
}

/**
 * Map an AgentOverrideConfig (from plugin config) to the subset of agent
 * config fields shown in the saved preset summary.
 */
export function mapOverrideToAgentConfig(
  override: AgentOverrideConfig,
): AgentUpdate {
  const agentConfig: AgentUpdate = {};

  if (typeof override.model === 'string') {
    agentConfig.model = override.model;
  } else if (Array.isArray(override.model) && override.model.length > 0) {
    // Array-form model (fallback chain): pick the first entry. Full chain
    // resolution happens at init time via the config() hook, so at runtime we
    // use the primary model from the array.
    const first = override.model[0];
    agentConfig.model = typeof first === 'string' ? first : first.id;
    if (typeof first !== 'string' && first.variant) {
      agentConfig.variant = first.variant;
    }
  }

  if (typeof override.temperature === 'number') {
    agentConfig.temperature = override.temperature;
  }

  if (typeof override.variant === 'string') {
    agentConfig.variant = override.variant;
  }

  if (
    override.options &&
    typeof override.options === 'object' &&
    !Array.isArray(override.options)
  ) {
    agentConfig.options = override.options;
  }

  return agentConfig;
}

/** Build the per-agent summary lines for a switch result / picker tooltip. */
export function buildPresetSummary(
  agentUpdates: Record<string, AgentUpdate>,
): string[] {
  const summaryParts: string[] = [];
  for (const [name, cfg] of Object.entries(agentUpdates)) {
    const parts: string[] = [name];
    if (cfg.model) parts.push(`model: ${cfg.model}`);
    if (cfg.variant) parts.push(`variant: ${cfg.variant}`);
    if (cfg.temperature !== undefined) parts.push(`temp: ${cfg.temperature}`);
    if (cfg.options) parts.push('options: yes');
    summaryParts.push(parts.join(' → '));
  }
  return summaryParts;
}

/**
 * Persist the preset name to the user-level config file so it survives
 * restarts. A failed write is reported to the caller, never claimed as success.
 */
function persistPresetName(directory: string, presetName: string): void {
  const { userConfigPath } = findPluginConfigPaths(directory);
  if (!userConfigPath) {
    throw new Error('No user-level mechanicus.json[c] config file was found.');
  }
  mutateJsonConfigFile(userConfigPath, (config) => ({
    ...config,
    preset: presetName,
  }));
}

const PresetMapSchema = z.record(z.string(), PresetSchema);

export type PresetEditResult = { ok: true } | { ok: false; message: string };

export function readUserPreset(
  directory: string,
  name: string,
): PresetInput | undefined {
  const { userConfigPath } = findPluginConfigPaths(directory);
  if (!userConfigPath) return undefined;
  const config = parseJsonConfigText(fs.readFileSync(userConfigPath, 'utf8'));
  const presets = PresetMapSchema.parse(config.presets ?? {});
  return Object.hasOwn(presets, name) ? presets[name] : undefined;
}

function projectPresets(directory: string): Record<string, PresetInput> {
  const { projectConfigPath } = findPluginConfigPaths(directory);
  if (!projectConfigPath) return {};
  const config = parseJsonConfigText(
    fs.readFileSync(projectConfigPath, 'utf8'),
  );
  return PresetMapSchema.parse(config.presets ?? {});
}

export function findPresetDependents(
  base: string,
  presets: Record<string, PresetInput>,
): string[] {
  return Object.entries(presets)
    .filter(
      ([name, preset]) =>
        name !== base && normalizePreset(preset).extends === base,
    )
    .map(([name]) => name);
}

export function wouldCreatePresetCycle(
  child: string,
  parent: string,
  presets: Record<string, PresetInput>,
): boolean {
  try {
    resolvePreset(child, {
      ...presets,
      [child]: { extends: parent, agents: {} },
    });
    return false;
  } catch {
    return true;
  }
}

function editUserPresets(
  directory: string,
  name: string,
  edit: (
    config: Record<string, unknown>,
    presets: Record<string, PresetInput>,
  ) => Record<string, unknown>,
): PresetEditResult {
  try {
    if (['__proto__', 'constructor', 'prototype'].includes(name)) {
      throw new Error('Reserved JavaScript property names cannot be edited');
    }
    const { userConfigPath } = findPluginConfigPaths(directory);
    if (!userConfigPath) throw new Error('No user-level config file was found');
    mutateJsonConfigFile(userConfigPath, (config) =>
      edit(config, PresetMapSchema.parse(config.presets ?? {})),
    );
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Validate and save local declarations; an editor snapshot protects later disk edits. */
export function writePresetWithResult(
  directory: string,
  name: string,
  preset: PresetInput,
  expected?: { original: PresetInput | undefined },
): PresetEditResult {
  return editUserPresets(directory, name, (config, presets) => {
    const current = Object.hasOwn(presets, name) ? presets[name] : undefined;
    if (expected && !isDeepStrictEqual(current, expected.original)) {
      throw new Error(
        `Preset "${name}" changed while editing; reopen it and retry`,
      );
    }
    const declaration = PresetSchema.parse(preset);
    const updated = { ...presets, [name]: declaration };
    // Validate both the global layer and the effective project layer. Never
    // materialize project fields or parent agents into the editable user file.
    resolvePreset(name, updated);
    resolvePreset(
      name,
      mergePresetMaps(updated, projectPresets(directory)) ?? updated,
    );
    const stored = config.presets as Record<string, unknown> | undefined;
    return { ...config, presets: { ...stored, [name]: declaration } };
  });
}

/**
 * Persist a preset (create or overwrite) into the user config's `presets`
 * object. Returns true on success.
 */
export function writePreset(
  directory: string,
  name: string,
  preset: PresetInput,
): boolean {
  return writePresetWithResult(directory, name, preset).ok;
}

/**
 * Delete a preset from the user config. Returns true if removed, false if the
 * preset did not exist or the write failed.
 */
export function deletePreset(directory: string, name: string): boolean {
  return deletePresetWithResult(directory, name).ok;
}

export function deletePresetWithResult(
  directory: string,
  name: string,
): PresetEditResult {
  return editUserPresets(directory, name, (config, presets) => {
    if (!Object.hasOwn(presets, name)) {
      throw new Error(`Preset "${name}" does not exist in the user config`);
    }
    const dependents = [
      ...new Set([
        ...findPresetDependents(name, presets),
        ...findPresetDependents(name, projectPresets(directory)),
      ]),
    ];
    if (dependents.length) {
      throw new Error(
        `Cannot delete "${name}": required by ${dependents.join(', ')}. Change their base preset first.`,
      );
    }
    const remaining = { ...(config.presets as Record<string, unknown>) };
    delete remaining[name];
    const next: Record<string, unknown> = { ...config, presets: remaining };
    if (next.preset === name) delete next.preset;
    return next;
  });
}

/**
 * Set (or replace) an agent override within an in-memory preset. Returns a
 * new preset object; does not mutate the input.
 */
export function setAgentOverride(
  preset: Preset,
  agentName: string,
  override: AgentOverrideConfig,
): Preset {
  return { ...preset, [agentName]: override };
}

/**
 * Remove an agent from an in-memory preset. Returns a new preset object; does
 * not mutate the input. If the agent was not present, the preset is unchanged.
 */
export function removeAgentFromPreset(
  preset: Preset,
  agentName: string,
): Preset {
  if (!Object.hasOwn(preset, agentName)) return preset;
  const next = { ...preset };
  delete next[agentName];
  return next;
}

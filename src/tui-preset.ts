/**
 * Three-level `/preset` manager for the TUI.
 *
 * Level 1 — preset list (Apply / Edit / Create / Delete)
 * Level 2 — agents in a preset (Add / Edit / Remove / Save)
 * Level 3 — edit one agent's model, variant, temperature, options
 *
 * Pure TUI: uses `api.ui.*` dialog primitives and `api.client.providers()`
 * for the model list. Never sends a message to the server's `command()` flow,
 * so it triggers no LLM turn — same channel as the built-in `/models`.
 *
 * All preset mutations are written to the user-level config file
 * (`mechanicus.json[c]`). Applying a preset persists the preset
 * name only — the sidebar is NOT refreshed mid-session, because the agent
 * registry is unchanged and showing new models against running agents
 * would be misleading. The new preset takes effect on the next
 * conversation/reload, when `loadPluginConfig` re-reads the config and
 * merges the preset into `config.agents`. This is deliberate: hot-swapping
 * the agent tree during an active conversation could truncate context (a
 * new model may have a smaller window), drift prior assistant turns under a
 * changed system prompt, leave running subagents referencing stale agent
 * definitions, or shift tool/skill availability underfoot. A future path
 * to true in-session switching without reset requires a host API for atomic
 * agent-registry refresh with session compatibility checks.
 */
import type {
  TuiDialogSelectOption,
  TuiPluginApi,
} from '@opencode-ai/plugin/tui';
import type { JSX } from '@opentui/solid';
import { createElement, insert } from '@opentui/solid';
import type {
  AgentOverrideConfig,
  Preset,
  PresetDefinition,
  PresetInput,
} from './config';
import { AGENT_ALIASES, ALL_AGENT_NAMES } from './config/constants';
import { loadPluginConfig } from './config/loader';
import { normalizePreset, tryResolvePreset } from './config/presets';
import {
  deletePresetWithResult,
  readUserPreset,
  removeAgentFromPreset,
  setAgentOverride,
  switchPresetOnDisk,
  wouldCreatePresetCycle,
  writePresetWithResult,
} from './tools/preset-switch';
import type { TuiSnapshot } from './tui-state';

/** Build a `<text>` JSX element — required for DialogPrompt.description(). */
function desc(text: string): JSX.Element {
  const node = createElement('text');
  insert(node, text);
  return node as unknown as JSX.Element;
}

/** Sentinel option values used to embed actions in `DialogSelect` lists. */
const ACTION_NEW_PRESET = '__omo_new_preset__';
const ACTION_ADD_AGENT = '__omo_add_agent__';
const ACTION_BASE = '__omo_base_preset__';
const INHERITED_PREFIX = '__omo_inherited__';
const USER_PREFIX = '__omo_user__';
const ACTION_BACK = '__omo_back__';

interface ManagerState {
  api: TuiPluginApi;
  directory: string;
  snapshotRef: { snapshot: TuiSnapshot };
  editOriginal?: { original: PresetInput | undefined };
}

/**
 * Entry point: open the preset manager at Level 1. Re-reads the config each
 * time it is opened so newly-edited files are reflected.
 */
export function openPresetManager(
  api: TuiPluginApi,
  directory: string,
  snapshotRef: { snapshot: TuiSnapshot },
): void {
  showPresetList({ api, directory, snapshotRef });
}

function showPresetList(state: ManagerState): void {
  const config = loadPluginConfig(state.directory, { silent: true });
  const presets = config.presets ?? {};
  const names = Object.keys(presets);
  const activePreset = config.preset ?? null;

  if (names.length === 0 && !activePreset) {
    // No presets at all: jump straight to "create" prompt.
    promptAndCreatePreset(state, () => showPresetList(state));
    return;
  }

  const options: TuiDialogSelectOption<string>[] = names.map((name) => ({
    title: name === activePreset ? `${name} (active)` : name,
    value: `${USER_PREFIX}${name}`,
    description: `${normalizePreset(presets[name]).extends ? `extends: ${normalizePreset(presets[name]).extends}; ` : ''}${describePreset(tryResolvePreset(name, presets) ?? {})}`,
  }));
  options.push({
    title: '+ Create new preset',
    value: ACTION_NEW_PRESET,
  });

  state.api.ui.dialog.replace(() =>
    state.api.ui.Dialog({
      size: 'large',
      onClose: () => state.api.ui.dialog.clear(),
      children: state.api.ui.DialogSelect<string>({
        title: 'Presets',
        placeholder: 'Select a preset to apply or edit',
        options,
        onSelect: (option) => {
          if (option.value === ACTION_NEW_PRESET) {
            promptAndCreatePreset(state, () => showPresetList(state));
            return;
          }
          showPresetActions(state, option.value.slice(USER_PREFIX.length));
        },
      }),
    }),
  );
}

function showPresetActions(state: ManagerState, presetName: string): void {
  const options: TuiDialogSelectOption<string>[] = [
    { title: 'Apply preset (reload to take effect)', value: 'apply' },
    { title: 'Edit agents', value: 'edit' },
    { title: 'Delete preset', value: 'delete' },
    { title: '← Back', value: ACTION_BACK },
  ];

  state.api.ui.dialog.replace(() =>
    state.api.ui.Dialog({
      size: 'large',
      onClose: () => state.api.ui.dialog.clear(),
      children: state.api.ui.DialogSelect<string>({
        title: `Preset: ${presetName}`,
        options,
        onSelect: (option) => {
          switch (option.value) {
            case 'apply':
              applyPreset(state, presetName);
              break;
            case 'edit':
              editPreset(state, presetName);
              break;
            case 'delete':
              confirmDeletePreset(state, presetName);
              break;
            default:
              showPresetList(state);
          }
        },
      }),
    }),
  );
}

function applyPreset(state: ManagerState, presetName: string): void {
  applyPresetWithMessage(state, presetName, 'Preset saved');
}

/**
 * Apply a preset and show a combined toast. `title` lets Save & Apply show
 * a single distinct message instead of two separate toasts.
 *
 * The new preset takes effect on the next conversation/reload — the
 * sidebar is NOT refreshed mid-session, because the agent registry is
 * unchanged and showing new models against running agents would be
 * misleading.
 */
function applyPresetWithMessage(
  state: ManagerState,
  presetName: string,
  title: string,
): void {
  const config = loadPluginConfig(state.directory, { silent: true });
  const result = switchPresetOnDisk(state.directory, presetName, config);
  state.api.ui.dialog.clear();
  state.api.ui.toast({
    variant: result.ok ? 'success' : 'warning',
    title: result.ok ? title : 'Preset switch failed',
    message: result.ok
      ? `Saved preset "${presetName}". Start a new conversation (or reload OpenCode) to use it. ${result.summary.join('; ')}`
      : result.message,
  });
}

function confirmDeletePreset(state: ManagerState, presetName: string): void {
  state.api.ui.dialog.replace(() =>
    state.api.ui.Dialog({
      size: 'large',
      onClose: () => state.api.ui.dialog.clear(),
      children: state.api.ui.DialogConfirm({
        title: 'Delete preset',
        message: `Delete preset "${presetName}"? This cannot be undone.`,
        onConfirm: () => {
          const result = deletePresetWithResult(state.directory, presetName);
          const ok = result.ok;
          state.api.ui.dialog.clear();
          state.api.ui.toast({
            variant: ok ? 'success' : 'warning',
            title: ok ? 'Preset deleted' : 'Delete failed',
            message: ok
              ? `Deleted preset "${presetName}".`
              : result.ok
                ? ''
                : result.message,
          });
          showPresetList(state);
        },
        onCancel: () => showPresetActions(state, presetName),
      }),
    }),
  );
}

function promptAndCreatePreset(
  state: ManagerState,
  onCancel: () => void,
): void {
  state.api.ui.dialog.replace(() =>
    state.api.ui.Dialog({
      size: 'large',
      onClose: () => state.api.ui.dialog.clear(),
      children: state.api.ui.DialogPrompt({
        title: 'Create new preset',
        placeholder: 'preset-name',
        onConfirm: (value) => {
          const name = value.trim();
          if (!name) {
            onCancel();
            return;
          }
          if (/\s/.test(name)) {
            state.api.ui.toast({
              variant: 'warning',
              title: 'Invalid name',
              message: 'Preset names cannot contain spaces.',
            });
            promptAndCreatePreset(state, onCancel);
            return;
          }
          if (['__proto__', 'constructor', 'prototype'].includes(name)) {
            state.api.ui.toast({
              variant: 'warning',
              title: 'Invalid name',
              message: 'Reserved JavaScript property names cannot be edited.',
            });
            return;
          }
          // Check for name collision before opening an empty working copy,
          // to avoid silently overwriting an existing preset on save.
          const config = loadPluginConfig(state.directory, {
            silent: true,
          });
          if (config.presets?.[name]) {
            confirmOverwritePreset(state, name, onCancel);
            return;
          }
          startPresetEdit(state, name, true);
        },
        onCancel,
      }),
    }),
  );
}

/**
 * Confirm overwriting an existing preset when the user enters a name that
 * already exists in the Create new preset prompt.
 */
function confirmOverwritePreset(
  state: ManagerState,
  name: string,
  onCancel: () => void,
): void {
  state.api.ui.dialog.replace(() =>
    state.api.ui.Dialog({
      size: 'large',
      onClose: () => state.api.ui.dialog.clear(),
      children: state.api.ui.DialogConfirm({
        title: 'Preset exists',
        message: `A preset named "${name}" already exists. Overwrite it with a new empty preset?`,
        onConfirm: () => {
          startPresetEdit(state, name, true);
        },
        onCancel: () => promptAndCreatePreset(state, onCancel),
      }),
    }),
  );
}

function editPreset(state: ManagerState, presetName: string): void {
  startPresetEdit(state, presetName, false);
}

function startPresetEdit(
  state: ManagerState,
  name: string,
  empty: boolean,
): void {
  try {
    const original = readUserPreset(state.directory, name);
    if (!empty && original === undefined) {
      throw new Error(
        'This preset is defined in project config. Edit its local file directly.',
      );
    }
    state.editOriginal = { original };
    const working =
      empty || !original ? { agents: {} } : normalizePreset(original);
    editPresetWorkingCopy(state, name, structuredClone(working));
  } catch (error) {
    state.api.ui.toast({
      variant: 'warning',
      title: 'Cannot edit preset',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function editPresetWorkingCopy(
  state: ManagerState,
  presetName: string,
  working: PresetDefinition,
): void {
  const allPresets =
    loadPluginConfig(state.directory, { silent: true }).presets ?? {};
  const parent = working.extends;
  const inherited =
    parent && !wouldCreatePresetCycle(presetName, parent, allPresets)
      ? tryResolvePreset(parent, allPresets)
      : undefined;
  const localNames = new Set(
    Object.keys(working.agents).map((name) => AGENT_ALIASES[name] ?? name),
  );
  const agentNames = Object.keys(working.agents);
  const options: TuiDialogSelectOption<string>[] = agentNames.map((name) => ({
    title: name,
    value: `${USER_PREFIX}${name}`,
    description: describeOverride(working.agents[name]),
  }));
  options.unshift({
    title: `Base preset: ${parent ?? '(none)'}`,
    value: ACTION_BASE,
    description:
      parent && !inherited
        ? 'Inheritance cannot be resolved. Select another base or remove it.'
        : 'Changes only the base reference; inherited agents remain read-only.',
  });
  for (const [name, override] of Object.entries(inherited ?? {})) {
    if (localNames.has(AGENT_ALIASES[name] ?? name)) continue;
    options.push({
      title: `${name} (inherited from ${parent})`,
      value: `${INHERITED_PREFIX}${name}`,
      description: describeOverride(override),
    });
  }
  options.push({ title: '+ Add agent', value: ACTION_ADD_AGENT });
  options.push({ title: '− Remove agent', value: '__omo_remove_agent__' });
  options.push({ title: '💾 Save', value: '__omo_save__' });
  options.push({
    title: '💾 Save & Apply',
    value: '__omo_save_apply__',
  });
  options.push({ title: '← Back', value: ACTION_BACK });

  state.api.ui.dialog.replace(() =>
    state.api.ui.Dialog({
      size: 'large',
      onClose: () => state.api.ui.dialog.clear(),
      children: state.api.ui.DialogSelect<string>({
        title: `Edit preset: ${presetName}`,
        options,
        onSelect: (option) => {
          switch (option.value) {
            case ACTION_BASE:
              pickBasePreset(state, presetName, working);
              break;
            case ACTION_ADD_AGENT:
              promptAddAgent(state, presetName, working);
              break;
            case '__omo_remove_agent__':
              promptRemoveAgent(state, presetName, working);
              break;
            case '__omo_save__':
              savePreset(state, presetName, working, false);
              break;
            case '__omo_save_apply__': {
              const saved = savePreset(state, presetName, working, false, true);
              if (saved) {
                applyPresetWithMessage(
                  state,
                  presetName,
                  'Preset saved for reload',
                );
              }
              break;
            }
            case ACTION_BACK:
              showPresetList(state);
              break;
            default:
              if (option.value.startsWith(INHERITED_PREFIX)) {
                state.api.ui.toast({
                  variant: 'info',
                  title: 'Inherited agent',
                  message: `Edit base preset "${parent}" or add a local override for this agent.`,
                });
              } else {
                editAgent(
                  state,
                  presetName,
                  working,
                  option.value.slice(USER_PREFIX.length),
                );
              }
          }
        },
      }),
    }),
  );
}

function pickBasePreset(
  state: ManagerState,
  name: string,
  working: PresetDefinition,
): void {
  const presets =
    loadPluginConfig(state.directory, { silent: true }).presets ?? {};
  const options: TuiDialogSelectOption<string>[] = [
    {
      title: '(none)',
      value: '__omo_no_base__',
      description: 'Use only local agent overrides.',
    },
    ...Object.keys(presets)
      .filter((candidate) => !wouldCreatePresetCycle(name, candidate, presets))
      .map((candidate) => ({
        title: candidate,
        value: `${USER_PREFIX}${candidate}`,
      })),
    { title: '← Back', value: ACTION_BACK },
  ];
  state.api.ui.dialog.replace(() =>
    state.api.ui.Dialog({
      size: 'large',
      onClose: () => state.api.ui.dialog.clear(),
      children: state.api.ui.DialogSelect<string>({
        title: `Base preset for ${name}`,
        options,
        onSelect: (option) => {
          if (option.value === ACTION_BACK) {
            editPresetWorkingCopy(state, name, working);
            return;
          }
          const next = { ...working };
          if (option.value === '__omo_no_base__') delete next.extends;
          else next.extends = option.value.slice(USER_PREFIX.length);
          editPresetWorkingCopy(state, name, next);
        },
      }),
    }),
  );
}

function promptAddAgent(
  state: ManagerState,
  presetName: string,
  working: PresetDefinition,
): void {
  const present = new Set(Object.keys(working.agents));
  const available = ALL_AGENT_NAMES.filter((n) => !present.has(n));
  if (available.length === 0) {
    state.api.ui.toast({
      variant: 'info',
      title: 'No agents left',
      message: 'All known agents are already in this preset.',
    });
    editPresetWorkingCopy(state, presetName, working);
    return;
  }
  const options: TuiDialogSelectOption<string>[] = available.map((n) => ({
    title: n,
    value: `${USER_PREFIX}${n}`,
  }));
  options.push({ title: '← Back', value: ACTION_BACK });

  state.api.ui.dialog.replace(() =>
    state.api.ui.Dialog({
      size: 'large',
      onClose: () => state.api.ui.dialog.clear(),
      children: state.api.ui.DialogSelect<string>({
        title: 'Add agent',
        options,
        onSelect: (option) => {
          if (option.value === ACTION_BACK) {
            editPresetWorkingCopy(state, presetName, working);
            return;
          }
          // Add the agent with an empty override, then jump to Level 3.
          const next = setAgentOverride(
            working.agents,
            option.value.slice(USER_PREFIX.length),
            {},
          );
          editAgent(
            state,
            presetName,
            { ...working, agents: next },
            option.value.slice(USER_PREFIX.length),
          );
        },
      }),
    }),
  );
}

function promptRemoveAgent(
  state: ManagerState,
  presetName: string,
  working: PresetDefinition,
): void {
  const agentNames = Object.keys(working.agents);
  if (agentNames.length === 0) {
    state.api.ui.toast({
      variant: 'info',
      title: 'No agents',
      message: 'This preset has no agents to remove.',
    });
    editPresetWorkingCopy(state, presetName, working);
    return;
  }
  const options: TuiDialogSelectOption<string>[] = agentNames.map((n) => ({
    title: n,
    value: `${USER_PREFIX}${n}`,
    description: describeOverride(working.agents[n]),
  }));
  options.push({ title: '← Back', value: ACTION_BACK });

  state.api.ui.dialog.replace(() =>
    state.api.ui.Dialog({
      size: 'large',
      onClose: () => state.api.ui.dialog.clear(),
      children: state.api.ui.DialogSelect<string>({
        title: 'Remove agent',
        options,
        onSelect: (option) => {
          if (option.value === ACTION_BACK) {
            editPresetWorkingCopy(state, presetName, working);
            return;
          }
          const next = removeAgentFromPreset(
            working.agents,
            option.value.slice(USER_PREFIX.length),
          );
          state.api.ui.toast({
            variant: 'success',
            title: 'Agent removed',
            message: `Removed ${option.value.slice(USER_PREFIX.length)} from preset.`,
          });
          editPresetWorkingCopy(state, presetName, {
            ...working,
            agents: next,
          });
        },
      }),
    }),
  );
}

function savePreset(
  state: ManagerState,
  presetName: string,
  working: PresetDefinition,
  returnToList: boolean,
  silent = false,
): boolean {
  // Strip agents whose override is empty — they add nothing to the preset.
  const cleaned: Preset = {};
  for (const [agent, override] of Object.entries(working.agents)) {
    if (Object.keys(override).length > 0) {
      Object.defineProperty(cleaned, agent, {
        value: override,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  }
  const result = writePresetWithResult(
    state.directory,
    presetName,
    working.extends ? { extends: working.extends, agents: cleaned } : cleaned,
    state.editOriginal,
  );
  const ok = result.ok;
  if (ok)
    state.editOriginal = {
      original: readUserPreset(state.directory, presetName),
    };
  if (!silent || !ok) {
    state.api.ui.toast({
      variant: ok ? 'success' : 'warning',
      title: ok ? 'Preset saved' : 'Save failed',
      message: ok
        ? `Saved preset "${presetName}" to config.`
        : result.ok
          ? ''
          : result.message,
    });
  }
  if (returnToList) {
    showPresetList(state);
  }
  return ok;
}

/**
 * Level 3: edit one agent's override. Walks through model → variant →
 * temperature → options, then commits back into the working preset.
 */
function editAgent(
  state: ManagerState,
  presetName: string,
  working: PresetDefinition,
  agentName: string,
): void {
  const current = working.agents[agentName] ?? {};
  pickModel(state, presetName, working, agentName, current);
}

interface ModelOption {
  /** Full `providerID/modelID` string used in the preset config. */
  value: string;
  title: string;
  description: string;
  /** Variant names available for this model, if any. */
  variants: string[];
}

async function fetchModelOptions(api: TuiPluginApi): Promise<ModelOption[]> {
  // Guard: the TUI's client may not expose config.providers in all builds.
  if (!api.client?.config?.providers) {
    return [];
  }
  const res = (await api.client.config.providers()) as {
    data?: {
      providers?: Array<{
        id: string;
        models: Record<
          string,
          { name?: string; variants?: Record<string, unknown> }
        >;
      }>;
    };
  };
  const providers = res.data?.providers ?? [];
  const options: ModelOption[] = [];
  for (const provider of providers) {
    if (!provider?.models) continue;
    for (const [modelId, model] of Object.entries(provider.models)) {
      if (!model) continue;
      options.push({
        value: `${provider.id}/${modelId}`,
        title: model.name ?? modelId,
        description: provider.id,
        variants: model.variants ? Object.keys(model.variants) : [],
      });
    }
  }
  return options;
}

function pickModel(
  state: ManagerState,
  presetName: string,
  working: PresetDefinition,
  agentName: string,
  current: AgentOverrideConfig,
): void {
  // Show a toast while fetching — we keep the current dialog (Level 2)
  // visible until the model list is ready, then replace. This avoids a
  // dialog state conflict where a loading dialog's onClose could fire
  // dialog.clear() while the async callback later calls dialog.replace().
  state.api.ui.toast({
    variant: 'info',
    title: 'Loading models',
    message: `Fetching available models for ${agentName}…`,
  });

  void (async () => {
    let options: ModelOption[];
    try {
      options = await fetchModelOptions(state.api);
    } catch (err) {
      state.api.ui.toast({
        variant: 'warning',
        title: 'Could not load models',
        message: `Failed to fetch providers: ${String(err)}`,
      });
      editPresetWorkingCopy(state, presetName, working);
      return;
    }

    if (options.length === 0) {
      state.api.ui.toast({
        variant: 'warning',
        title: 'No models available',
        message:
          'Could not retrieve the model list. You can edit the preset config file manually.',
      });
      editPresetWorkingCopy(state, presetName, working);
      return;
    }

    try {
      // Only pass `current` if it matches an existing option, to avoid
      // DialogSelect crashing on a non-existent current value.
      const currentModel =
        typeof current.model === 'string'
          ? options.find((o) => o.value === current.model)?.value
          : undefined;

      const selectOptions: TuiDialogSelectOption<string>[] = options.map(
        (o) => ({
          title: o.title,
          value: o.value,
          description: o.description,
        }),
      );

      state.api.ui.dialog.replace(() =>
        state.api.ui.Dialog({
          size: 'large',
          onClose: () => state.api.ui.dialog.clear(),
          children: state.api.ui.DialogSelect<string>({
            title: `Edit ${agentName} — model`,
            placeholder: 'Search models',
            current: currentModel,
            options: selectOptions,
            onSelect: (option) => {
              const chosen = options.find((o) => o.value === option.value);
              const next: AgentOverrideConfig = {
                ...current,
                model: option.value,
              };
              pickVariant(
                state,
                presetName,
                working,
                agentName,
                next,
                chosen?.variants ?? [],
              );
            },
          }),
        }),
      );
    } catch (err) {
      state.api.ui.toast({
        variant: 'error',
        title: 'Model picker error',
        message: String(err),
      });
      editPresetWorkingCopy(state, presetName, working);
    }
  })();
}

function pickVariant(
  state: ManagerState,
  presetName: string,
  working: PresetDefinition,
  agentName: string,
  current: AgentOverrideConfig,
  availableVariants: string[],
): void {
  // No variants for this model → skip to temperature.
  if (availableVariants.length === 0) {
    pickTemperature(state, presetName, working, agentName, current);
    return;
  }

  const options: TuiDialogSelectOption<string>[] = [
    { title: 'none', value: '', description: 'no variant' },
    ...availableVariants.map((v) => ({ title: v, value: v })),
  ];

  state.api.ui.dialog.replace(() =>
    state.api.ui.Dialog({
      size: 'large',
      onClose: () => state.api.ui.dialog.clear(),
      children: state.api.ui.DialogSelect<string>({
        title: `Edit ${agentName} — variant (thinking strength)`,
        current: typeof current.variant === 'string' ? current.variant : '',
        options,
        onSelect: (option) => {
          const next: AgentOverrideConfig = { ...current };
          if (option.value) {
            next.variant = option.value;
          } else {
            delete next.variant;
          }
          pickTemperature(state, presetName, working, agentName, next);
        },
      }),
    }),
  );
}

function pickTemperature(
  state: ManagerState,
  presetName: string,
  working: PresetDefinition,
  agentName: string,
  current: AgentOverrideConfig,
): void {
  state.api.ui.dialog.replace(() =>
    state.api.ui.Dialog({
      size: 'large',
      onClose: () => state.api.ui.dialog.clear(),
      children: state.api.ui.DialogPrompt({
        title: `Edit ${agentName} — temperature`,
        description: () =>
          desc(
            'Enter a number 0–2, or leave blank for the provider default (typically 1.0).',
          ),
        value:
          typeof current.temperature === 'number'
            ? String(current.temperature)
            : '',
        placeholder: 'none',
        onConfirm: (value) => {
          const trimmed = value.trim();
          const next: AgentOverrideConfig = { ...current };
          if (trimmed) {
            const parsed = Number(trimmed);
            if (Number.isNaN(parsed) || parsed < 0 || parsed > 2) {
              state.api.ui.toast({
                variant: 'warning',
                title: 'Invalid temperature',
                message: 'Temperature must be a number between 0 and 2.',
              });
              pickTemperature(state, presetName, working, agentName, current);
              return;
            }
            next.temperature = parsed;
          } else {
            delete next.temperature;
          }
          pickOptions(state, presetName, working, agentName, next);
        },
        onCancel: () => editPresetWorkingCopy(state, presetName, working),
      }),
    }),
  );
}

function pickOptions(
  state: ManagerState,
  presetName: string,
  working: PresetDefinition,
  agentName: string,
  current: AgentOverrideConfig,
): void {
  const currentJson =
    current.options && typeof current.options === 'object'
      ? JSON.stringify(current.options)
      : '{}';
  state.api.ui.dialog.replace(() =>
    state.api.ui.Dialog({
      size: 'large',
      onClose: () => state.api.ui.dialog.clear(),
      children: state.api.ui.DialogPrompt({
        title: `Edit ${agentName} — options (JSON)`,
        description: () =>
          desc(
            'Provider-specific options as JSON, e.g. {"thinking":{"type":"enabled","budgetTokens":10000}}. Use {} for none.',
          ),
        value: currentJson,
        placeholder: '{}',
        onConfirm: (value) => {
          const trimmed = value.trim() || '{}';
          let parsed: Record<string, unknown>;
          try {
            const value: unknown = JSON.parse(trimmed);
            if (!value || typeof value !== 'object' || Array.isArray(value)) {
              throw new Error('Expected an object');
            }
            parsed = value as Record<string, unknown>;
          } catch {
            state.api.ui.toast({
              variant: 'warning',
              title: 'Invalid JSON',
              message: 'Options must be a valid JSON object.',
            });
            pickOptions(state, presetName, working, agentName, current);
            return;
          }
          const next: AgentOverrideConfig = { ...current };
          if (Object.keys(parsed).length > 0) {
            next.options = parsed;
          } else {
            delete next.options;
          }
          // Commit back into the working preset and return to Level 2.
          const updated = setAgentOverride(working.agents, agentName, next);
          state.api.ui.toast({
            variant: 'success',
            title: 'Agent updated',
            message: `${agentName} → ${describeOverride(next)}`,
          });
          editPresetWorkingCopy(state, presetName, {
            ...working,
            agents: updated,
          });
        },
        onCancel: () => editPresetWorkingCopy(state, presetName, working),
      }),
    }),
  );
}

// --- formatting helpers (also used by the simple list view if needed) ---

function describePreset(preset: Preset): string {
  const parts = Object.entries(preset).map(
    ([agent, override]) => `${agent}: ${describeOverride(override)}`,
  );
  return parts.length > 0 ? parts.join(', ') : '(empty)';
}

function describeOverride(override: AgentOverrideConfig): string {
  const bits: string[] = [];
  if (typeof override.model === 'string') {
    bits.push(override.model);
  } else if (Array.isArray(override.model) && override.model.length > 0) {
    const first = override.model[0];
    bits.push(typeof first === 'string' ? first : first.id);
  }
  if (typeof override.variant === 'string')
    bits.push(`variant=${override.variant}`);
  if (typeof override.temperature === 'number')
    bits.push(`temp=${override.temperature}`);
  if (override.options && Object.keys(override.options).length > 0)
    bits.push('options');
  return bits.length > 0 ? bits.join(', ') : '(unset)';
}

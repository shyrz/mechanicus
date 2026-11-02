import { loadPluginConfig } from '../config/loader';
import type { SessionPresetState } from './session-preset-store';
import type { V2CommandDefinition } from './types';

export function availablePresetNames(directory: string): {
  names: string[];
  active?: string;
} {
  const config = loadPluginConfig(directory, { silent: true });
  return {
    names: Object.keys(config.presets ?? {}).sort((a, b) => a.localeCompare(b)),
    ...(config.preset ? { active: config.preset } : {}),
  };
}

export function createSessionPresetCommand(options: {
  directory: string;
  read: (id: string) => Promise<SessionPresetState>;
  apply: (id: string, name: string) => Promise<SessionPresetState>;
}): V2CommandDefinition {
  return {
    name: 'preset',
    description: 'List presets, or apply one to future child sessions',
    execute: async ({ sessionID, prompt }) => {
      const name = prompt.text.trim();
      let feedback: string;
      if (!name) {
        const { names, active } = availablePresetNames(options.directory);
        let current = 'unavailable';
        try {
          current = (await options.read(sessionID)).presetName ?? 'not bound';
        } catch {
          // Never present the global default as a proven session binding.
        }
        feedback = `Available presets: ${names.join(', ') || 'none'}. Session team: ${current}. Global default: ${active ?? 'none'}.`;
      } else if (
        !availablePresetNames(options.directory).names.includes(name)
      ) {
        feedback = `Preset "${name}" was not applied: it does not exist.`;
      } else {
        try {
          await options.apply(sessionID, name);
          feedback = `Applied preset "${name}" to this session's future child sessions. The root model, existing children and global default are unchanged. Command feedback is returned through the host command error channel.`;
        } catch (error) {
          feedback = `Preset "${name}" was not applied: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      throw new Error(feedback);
    },
  };
}

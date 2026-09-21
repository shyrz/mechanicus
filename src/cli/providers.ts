import { DEFAULT_AGENT_MCPS } from '../config/agent-mcps';
import { PRIMARY_AGENT_NAME } from '../config/constants';
import { CUSTOM_SKILLS } from './custom-skills';
import type { InstallConfig } from './types';

const SCHEMA_URL =
  'https://raw.githubusercontent.com/shyrz/mechanicus/master/mechanicus.schema.json';

export const GENERATED_PRESETS = ['openai', 'opencode-go'] as const;

// Model mappings by provider/preset.
export const MODEL_MAPPINGS = {
  openai: {
    omnissiah: { model: 'openai/gpt-5.6-terra', variant: 'high' },
    dominus: { model: 'openai/gpt-5.6-sol', variant: 'high' },
    logis: { model: 'openai/gpt-5.6-luna', variant: 'low' },
    magos: { model: 'openai/gpt-5.6-luna', variant: 'low' },
    artisan: { model: 'openai/gpt-5.6-luna', variant: 'medium' },
    genetor: { model: 'openai/gpt-5.6-luna', variant: 'high' },
  },
  kimi: {
    omnissiah: { model: 'kimi-for-coding/k2p5', variant: 'max' },
    dominus: { model: 'kimi-for-coding/k2p5', variant: 'high' },
    logis: { model: 'kimi-for-coding/k2p5', variant: 'low' },
    magos: { model: 'kimi-for-coding/k2p5', variant: 'low' },
    artisan: { model: 'kimi-for-coding/k2p5', variant: 'medium' },
    genetor: { model: 'kimi-for-coding/k2p5', variant: 'low' },
  },
  copilot: {
    omnissiah: { model: 'github-copilot/claude-opus-4.6', variant: 'max' },
    dominus: { model: 'github-copilot/claude-opus-4.6', variant: 'high' },
    logis: { model: 'github-copilot/grok-code-fast-1', variant: 'low' },
    magos: { model: 'github-copilot/grok-code-fast-1', variant: 'low' },
    artisan: {
      model: 'github-copilot/gemini-3.1-pro-preview',
      variant: 'medium',
    },
    genetor: { model: 'github-copilot/claude-sonnet-4.6', variant: 'low' },
  },
  'zai-plan': {
    omnissiah: { model: 'zai-coding-plan/glm-5', variant: 'max' },
    dominus: { model: 'zai-coding-plan/glm-5', variant: 'high' },
    logis: { model: 'zai-coding-plan/glm-5', variant: 'low' },
    magos: { model: 'zai-coding-plan/glm-5', variant: 'low' },
    artisan: { model: 'zai-coding-plan/glm-5', variant: 'medium' },
    genetor: { model: 'zai-coding-plan/glm-5', variant: 'low' },
  },
  'opencode-go': {
    omnissiah: { model: 'opencode-go/minimax-m3', variant: 'thinking' },
    dominus: { model: 'opencode-go/qwen3.7-max', variant: 'max' },
    magos: { model: 'opencode-go/deepseek-v4-flash', variant: 'high' },
    logis: { model: 'opencode-go/deepseek-v4-flash', variant: 'high' },
    artisan: { model: 'opencode-go/kimi-k2.7-code' },
    genetor: { model: 'opencode-go/deepseek-v4-flash', variant: 'high' },
    observer: { model: 'opencode-go/mimo-v2.5' },
  },
} as const;

export type PresetName = keyof typeof MODEL_MAPPINGS;
export type GeneratedPresetName = (typeof GENERATED_PRESETS)[number];

export function isGeneratedPresetName(
  value: string,
): value is GeneratedPresetName {
  return GENERATED_PRESETS.includes(value as GeneratedPresetName);
}

export function getGeneratedPresetNames(): GeneratedPresetName[] {
  return [...GENERATED_PRESETS];
}

export function generateLiteConfig(
  installConfig: InstallConfig,
): Record<string, unknown> {
  const preset = installConfig.preset ?? 'openai';
  if (!isGeneratedPresetName(preset)) {
    throw new Error(
      `Unsupported preset "${preset}". Available generated presets: ${getGeneratedPresetNames().join(', ')}`,
    );
  }

  const config: Record<string, unknown> = {
    $schema: SCHEMA_URL,
    preset,
    presets: {},
  };

  if (preset === 'opencode-go') {
    config.disabled_agents = [];
  }

  const createAgentConfig = (
    agentName: string,
    modelInfo: { model: string; variant?: string },
  ) => {
    const isOrchestrator = agentName === PRIMARY_AGENT_NAME;

    const skills = isOrchestrator
      ? ['*']
      : [
          ...CUSTOM_SKILLS.filter(
            (s) =>
              s.allowedAgents.includes('*') ||
              s.allowedAgents.includes(agentName),
          ).map((s) => s.name),
        ];

    return {
      model: modelInfo.model,
      variant: modelInfo.variant,
      skills,
      mcps:
        DEFAULT_AGENT_MCPS[agentName as keyof typeof DEFAULT_AGENT_MCPS] ?? [],
    };
  };

  const buildPreset = (mappingName: PresetName) => {
    const mapping = MODEL_MAPPINGS[mappingName];
    return Object.fromEntries(
      Object.entries(mapping).map(([agentName, modelInfo]) => [
        agentName,
        createAgentConfig(agentName, modelInfo),
      ]),
    );
  };

  const presets = config.presets as Record<string, unknown>;
  for (const presetName of GENERATED_PRESETS) {
    presets[presetName] = buildPreset(presetName);
  }

  if (installConfig.companion === 'yes') {
    config.companion = {
      enabled: true,
      position: 'bottom-right',
      size: 'medium',
      gifPack: 'default',
      loopStyle: 'classic',
      speed: 1,
      debug: false,
    };
  }

  return config;
}

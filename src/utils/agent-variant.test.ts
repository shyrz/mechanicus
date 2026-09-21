import { describe, expect, test } from 'bun:test';
import type { PluginConfig } from '../config';
import { RuntimeConfig } from '../config/runtime';
import { normalizeAgentName, resolveRuntimeAgentName } from './agent-variant';

const TEST_DIRECTORY = 'runtime-test-agent-variant';

function runtimeFor(config: PluginConfig | undefined = {}) {
  RuntimeConfig.reset(TEST_DIRECTORY);
  RuntimeConfig.init(TEST_DIRECTORY, config ?? {});
  return RuntimeConfig.get(TEST_DIRECTORY);
}

describe('normalizeAgentName', () => {
  test('returns name unchanged if no @ prefix', () => {
    expect(normalizeAgentName('dominus')).toBe('dominus');
  });

  test('strips @ prefix from agent name', () => {
    expect(normalizeAgentName('@dominus')).toBe('dominus');
  });

  test('trims whitespace', () => {
    expect(normalizeAgentName('  dominus  ')).toBe('dominus');
  });

  test('handles @ prefix with whitespace', () => {
    expect(normalizeAgentName('  @magos  ')).toBe('magos');
  });

  test('handles empty string', () => {
    expect(normalizeAgentName('')).toBe('');
  });
});

describe('resolveRuntimeAgentName', () => {
  test('keeps internal agent names unchanged', () => {
    const config = {
      agents: {
        dominus: { displayName: 'advisor' },
      },
    } as PluginConfig;

    expect(resolveRuntimeAgentName(runtimeFor(config), 'dominus')).toBe(
      'dominus',
    );
  });

  test('resolves displayName to internal name', () => {
    const config = {
      agents: {
        dominus: { displayName: 'advisor' },
      },
    } as PluginConfig;

    expect(resolveRuntimeAgentName(runtimeFor(config), 'advisor')).toBe(
      'dominus',
    );
  });

  test('resolves legacy aliases to internal names', () => {
    expect(
      resolveRuntimeAgentName(runtimeFor({} as PluginConfig), 'oracle'),
    ).toBe('dominus');
    expect(
      resolveRuntimeAgentName(runtimeFor({} as PluginConfig), 'explore'),
    ).toBe('magos');
  });

  test('resolves displayName with @ prefix and whitespace', () => {
    const config = {
      agents: {
        dominus: { displayName: 'advisor' },
      },
    } as PluginConfig;

    expect(resolveRuntimeAgentName(runtimeFor(config), '  @advisor  ')).toBe(
      'dominus',
    );
  });

  test('resolves displayName configured via legacy alias key', () => {
    const config = {
      agents: {
        explore: { displayName: 'researcher' },
      },
    } as PluginConfig;

    expect(resolveRuntimeAgentName(runtimeFor(config), 'researcher')).toBe(
      'magos',
    );
  });

  test('returns normalized name when no displayName match exists', () => {
    const config = {
      agents: {
        dominus: { displayName: 'advisor' },
      },
    } as PluginConfig;

    expect(resolveRuntimeAgentName(runtimeFor(config), '  @unknown  ')).toBe(
      'unknown',
    );
  });
});

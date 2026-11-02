import { describe, expect, test } from 'bun:test';
import type { PresetMap } from './presets';
import {
  mergeAgentLayers,
  mergePresetMaps,
  normalizePreset,
  PresetResolutionError,
  resolvePreset,
  tryResolvePreset,
} from './presets';
import { PresetSchema } from './schema';

describe('preset inheritance', () => {
  test('retains a legacy agent named agents or extends', () => {
    const agents = {
      agents: { model: 'custom/agents' },
      extends: { model: 'custom/extends' },
    };
    expect(PresetSchema.parse(agents)).toEqual(agents);
    expect(normalizePreset(agents)).toEqual({ agents });
  });

  test('accepts structured and inline declarations', () => {
    expect(
      normalizePreset(
        PresetSchema.parse({
          extends: 'base',
          agents: { orchestrator: { model: 'child/model' } },
        }),
      ),
    ).toEqual({
      extends: 'base',
      agents: { orchestrator: { model: 'child/model' } },
    });
    expect(
      normalizePreset(
        PresetSchema.parse({
          extends: 'base',
          orchestrator: { temperature: 0.2 },
        }),
      ),
    ).toEqual({
      extends: 'base',
      agents: { orchestrator: { temperature: 0.2 } },
    });
  });

  test('resolves parent fields then child overrides and caches complete chains', () => {
    const presets: PresetMap = {
      base: { orchestrator: { model: 'base/model', temperature: 0.1 } },
      middle: {
        extends: 'base',
        agents: { orchestrator: { variant: 'low' } },
      },
      leaf: {
        extends: 'middle',
        orchestrator: { temperature: 0.7 },
      },
    };
    expect(resolvePreset('leaf', presets)).toEqual({
      omnissiah: {
        model: 'base/model',
        variant: 'low',
        temperature: 0.7,
      },
    });
  });

  test('project layers merge child fields and preserve an inherited parent', () => {
    const merged = mergePresetMaps(
      {
        child: {
          extends: 'base',
          agents: { orchestrator: { model: 'user/model', temperature: 0.1 } },
        },
      },
      {
        child: {
          agents: { orchestrator: { variant: 'low' } },
        },
      },
    );
    expect(merged).toBeDefined();
    expect(
      resolvePreset('child', {
        ...merged,
        base: { orchestrator: { options: { reasoning: true } } },
      }),
    ).toEqual({
      omnissiah: {
        model: 'user/model',
        options: { reasoning: true },
        temperature: 0.1,
        variant: 'low',
      },
    });
  });

  test('canonical agent fields win over aliases without losing other fields', () => {
    expect(
      mergeAgentLayers(
        {},
        {
          orchestrator: { temperature: 0.1, variant: 'low' },
          omnissiah: { temperature: 0.9 },
        },
      ),
    ).toEqual({
      omnissiah: { temperature: 0.9, variant: 'low' },
    });
  });

  test('an explicit model inheritance policy clears an inherited model', () => {
    const presets: PresetMap = {
      base: { orchestrator: { model: 'base/model', variant: 'high' } },
      child: {
        extends: 'base',
        orchestrator: { inheritModelFrom: 'session' },
      },
    };
    expect(resolvePreset('child', presets)).toEqual({
      omnissiah: { inheritModelFrom: 'session', variant: 'high' },
    });
  });

  test('reports the complete missing-parent chain', () => {
    expect(() =>
      resolvePreset('child', { child: { extends: 'missing', agents: {} } }),
    ).toThrow(PresetResolutionError);
    try {
      resolvePreset('child', { child: { extends: 'missing', agents: {} } });
    } catch (error) {
      expect(error).toMatchObject({
        kind: 'missing-parent',
        chain: ['child', 'missing'],
      });
    }
  });

  test('reports cycles without a partial result or unbounded recursion', () => {
    const presets: PresetMap = {
      a: { extends: 'b', agents: {} },
      b: { extends: 'a', agents: {} },
    };
    expect(tryResolvePreset('a', presets)).toBeUndefined();
    expect(() => resolvePreset('a', presets)).toThrow('a -> b -> a');
  });

  test('an unrelated broken preset does not prevent a valid selection', () => {
    const presets: PresetMap = {
      broken: { extends: 'broken', agents: {} },
      valid: { orchestrator: { model: 'valid/model' } },
    };
    expect(resolvePreset('valid', presets)).toEqual({
      orchestrator: { model: 'valid/model' },
    });
  });

  test('a child can extend a layered parent and override only one field', () => {
    const merged = mergePresetMaps(
      {
        parent: { orchestrator: { model: 'user/model', temperature: 0.1 } },
      },
      {
        parent: { orchestrator: { variant: 'high' } },
        child: { extends: 'parent', agents: { explorer: { model: 'child' } } },
      },
    );
    expect(merged).toBeDefined();
    expect(resolvePreset('child', merged ?? {})).toEqual({
      omnissiah: { model: 'user/model', temperature: 0.1, variant: 'high' },
      magos: { model: 'child' },
    });
  });

  test('prototype-looking preset and agent names remain own data', () => {
    const presets: PresetMap = JSON.parse(
      '{"__proto__":{"extends":"base","agents":{}},"base":{"__proto__":{"model":"safe/model"}}}',
    );
    const resolved = resolvePreset('__proto__', presets);
    expect(Object.hasOwn(resolved, '__proto__')).toBe(true);
    // biome-ignore lint/complexity/useLiteralKeys lint/suspicious/noProto: Verify an own data property, not the legacy prototype accessor.
    expect(resolved['__proto__']).toEqual({ model: 'safe/model' });
    expect({}.model).toBeUndefined();
  });
});

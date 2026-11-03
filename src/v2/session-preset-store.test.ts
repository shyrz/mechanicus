import { describe, expect, test } from 'bun:test';
import {
  applySessionPresetOptions,
  createSessionPresetStore,
  type SessionPresetBundle,
} from './session-preset-store';
import type { V2Context } from './types';

const bundle = (name: string, model = 'provider/one'): SessionPresetBundle => ({
  presetName: name,
  fallbackEnabled: true,
  profiles: {
    magos: {
      model: { providerID: 'provider', id: model.slice('provider/'.length) },
      temperature: 0.2,
      options: { reasoningEffort: 'low' },
      managedOptionKeys: ['reasoningEffort', 'oldOption'],
    },
  },
  chains: { magos: [model, 'provider/fallback'] },
});

function fixture(failSwitch = false) {
  const kv = new Map<string, unknown>();
  const calls: string[] = [];
  const ctx = {
    storage: {
      get: async (key: string) => kv.get(key),
      set: async (key: string, value: unknown) => {
        kv.set(key, value);
      },
      remove: async (key: string) => {
        kv.delete(key);
      },
      scan: async () => ({ entries: [] }),
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({
        id: sessionID,
        directory: '/project',
        ...(sessionID === 'child'
          ? { parentID: 'root', agent: 'magos' }
          : { agent: 'omnissiah' }),
      }),
      switchModel: async ({ model }: { model: { id: string } }) => {
        if (failSwitch) throw new Error('switch failed');
        calls.push(model.id);
      },
    },
  } as unknown as V2Context;
  const store = createSessionPresetStore({
    ctx,
    directory: '/project',
    current: () => bundle('default'),
    named: async (name) => bundle(name, 'provider/two'),
    agents: new Set(['magos']),
  });
  return { store, kv, calls };
}

describe('v2 session preset store', () => {
  test('root binding affects descendants, not its own model', async () => {
    const { store, kv } = fixture();
    await store.apply('root', 'cheap');
    expect(kv.has('session-preset/v1/root')).toBe(true);
    expect(await store.capture('root', await store.ensure('root'))).toBeNull();
    const root = await store.ensure('root');
    if (!root?.record) throw new Error('root snapshot missing');
    await store.bindChild({
      childID: 'child',
      parentID: 'root',
      bundle: root.record.bundle,
    });
    const profile = await store.capture('child', await store.ensure('child'));
    expect(profile?.model?.id).toBe('two');
    expect(store.peek('child')?.bundle.chains.magos).toEqual([
      'provider/two',
      'provider/fallback',
    ]);
  });

  test('a child keeps its launch execution after a later rebind', async () => {
    const { store } = fixture();
    await store.bindChild({
      childID: 'child',
      parentID: 'root',
      bundle: bundle('default'),
    });
    await store.apply('child', 'cheap');
    const admission = await store.ensure('child');
    if (!admission?.record) throw new Error('child snapshot missing');
    const record = admission.record;
    expect(record.bundle.presetName).toBe('cheap');
    expect(record.execution?.presetName).toBe('default');
  });

  test('identity mismatch and damaged storage fail closed', async () => {
    const { store, kv, calls } = fixture();
    kv.set('session-preset/v1/child', {
      schemaVersion: 1,
      parentID: 'someone-else',
      bundle: bundle('default'),
    });
    await expect(store.capture('child')).rejects.toThrow('parent identity');
    expect(calls).toEqual([]);
    kv.set('session-preset/v1/child', { schemaVersion: 1, bundle: 'bad' });
    await expect(store.capture('child')).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  test('capture switches model before exposing request options', async () => {
    const { store } = fixture();
    await store.bindChild({
      childID: 'child',
      parentID: 'root',
      bundle: bundle('default'),
    });
    store.profile('child');
    expect(await store.capture('child')).not.toBeNull();
  });

  test('a model-switch failure does not capture request options', async () => {
    const { store } = fixture(true);
    await store.bindChild({
      childID: 'child',
      parentID: 'root',
      bundle: bundle('default'),
    });
    await expect(store.capture('child')).rejects.toThrow('switch failed');
    expect(store.profile('child')).toBeUndefined();
  });

  test('options only replace managed inference fields', () => {
    const event = {
      model: { providerID: 'provider', id: 'one' },
      options: {
        temperature: 0.9,
        oldOption: true,
        unrelated: 'retained',
      },
      system: [{ type: 'text', text: 'frozen' }],
      messages: [{ role: 'user', content: [] }],
      tools: { read: true },
    };
    const before = JSON.stringify([event.system, event.messages, event.tools]);
    applySessionPresetOptions(event, bundle('default').profiles.magos);
    expect(event.options).toEqual({
      temperature: 0.2,
      unrelated: 'retained',
      reasoningEffort: 'low',
    });
    expect(JSON.stringify([event.system, event.messages, event.tools])).toBe(
      before,
    );
  });

  test('options never cross provider boundaries', () => {
    const event = {
      model: { providerID: 'other', id: 'one' },
      options: { temperature: 0.9, oldOption: true, unrelated: 'retained' },
    };
    applySessionPresetOptions(event, bundle('default').profiles.magos);
    expect(event.options).toEqual({
      temperature: 0.9,
      oldOption: true,
      unrelated: 'retained',
    });
  });

  test('managed options include the initial agent request keys', () => {
    const event = {
      model: { providerID: 'provider', id: 'two' },
      options: { oldOption: true, retained: false },
    };
    applySessionPresetOptions(event, {
      managedOptionKeys: ['oldOption'],
    });
    expect(event.options).toEqual({ retained: false });
  });

  test('a historical child without a launch snapshot remains untouched', async () => {
    const { store, calls, kv } = fixture();
    expect(await store.capture('child')).toBeNull();
    expect(calls).toEqual([]);
    expect(kv.has('session-preset/v1/child')).toBe(false);
  });

  test('concurrent bindings on one root preserve the last command', async () => {
    const { store } = fixture();
    await Promise.all([
      store.apply('root', 'cheap'),
      store.apply('root', 'balanced'),
    ]);
    expect((await store.state('root')).presetName).toBe('balanced');
  });

  test('non-JSON and wrong-generation storage never guess a profile', async () => {
    const { store, kv, calls } = fixture();
    kv.set('session-preset/v1/child', new Map());
    await expect(store.capture('child')).rejects.toThrow('not JSON');
    kv.set('session-preset/v1/child', {
      schemaVersion: 2,
      parentID: 'root',
      bundle: bundle('default'),
    });
    await expect(store.capture('child')).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  test('already frozen snapshots remain reusable', async () => {
    const current = bundle('default');
    Object.freeze(current);
    const { store } = fixture();
    await store.bindChild({
      childID: 'child',
      parentID: 'root',
      bundle: current,
      execution: current,
    });
    expect(store.peek('child')?.execution?.presetName).toBe('default');
  });

  test('deletion removes the durable snapshot and disposal fences writes', async () => {
    const { store, kv } = fixture();
    await store.ensure('root');
    await store.remove('root');
    expect(kv.has('session-preset/v1/root')).toBe(false);
    await store.dispose();
    await expect(store.apply('root', 'cheap')).rejects.toThrow('retired');
  });
});

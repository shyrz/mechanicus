import path from 'node:path';
import { z } from 'zod';
import type { V2Context } from './types';

const model = z.object({
  id: z.string().min(1),
  providerID: z.string().min(1),
  variant: z.string().optional(),
});
const profile = z.object({
  model: model.optional(),
  temperature: z.number().finite().optional(),
  options: z.record(z.string(), z.unknown()).optional(),
  managedOptionKeys: z.array(z.string()),
  inheritModelFrom: z.enum(['session', 'orchestrator']).optional(),
});
export const sessionPresetBundleSchema = z.object({
  presetName: z.string().nullable(),
  fallbackEnabled: z.boolean(),
  profiles: z.record(z.string(), profile),
  chains: z.record(z.string(), z.array(z.string())),
});
export type SessionPresetBundle = z.infer<typeof sessionPresetBundleSchema>;
export type SessionPresetProfile = z.infer<typeof profile>;
const recordSchema = z.object({
  schemaVersion: z.literal(1),
  parentID: z.string().optional(),
  bundle: sessionPresetBundleSchema,
  execution: sessionPresetBundleSchema.optional(),
});
export type SessionPresetRecord = z.infer<typeof recordSchema>;

export interface SessionPresetState {
  presetName: string | null;
  status: 'bound' | 'unbound';
  affects: 'future-children-only';
}

export interface SessionPresetAdmission {
  record: SessionPresetRecord | undefined;
  parentID?: string;
  agent?: string;
  model?: unknown;
}

function assertJson(value: unknown): void {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertJson(item);
    return;
  }
  if (
    typeof value === 'object' &&
    value &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    for (const item of Object.values(value)) assertJson(item);
    return;
  }
  throw new Error('Session preset snapshot is not JSON');
}

function frozen<T>(value: T, seen = new Set<object>()): T {
  if (value && typeof value === 'object') {
    if (Object.isFrozen(value)) return value;
    if (seen.has(value)) {
      throw new Error('Session preset snapshot is cyclic');
    }
    seen.add(value);
    for (const child of Object.values(value)) frozen(child, seen);
    seen.delete(value);
    Object.freeze(value);
  }
  return value;
}

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Session preset operation timed out')),
          10_000,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Host KV is authoritative; one-session locks cover binding transactions,
 * not native inference. Unavailable/invalid records never guess a profile. */
export function createSessionPresetStore(options: {
  ctx: V2Context;
  directory: string;
  current: () => SessionPresetBundle;
  named: (name: string) => Promise<SessionPresetBundle>;
  agents: ReadonlySet<string>;
}) {
  const storage = options.ctx.storage;
  const backend = storage
    ? {
        get: storage.get.bind(storage),
        set: storage.set.bind(storage),
        remove: storage.remove.bind(storage),
      }
    : undefined;
  const getSession = options.ctx.session.get?.bind(options.ctx.session);
  const switchModel = options.ctx.session.switchModel?.bind(
    options.ctx.session,
  );
  const available =
    typeof storage?.get === 'function' &&
    typeof storage?.set === 'function' &&
    typeof storage?.remove === 'function' &&
    typeof getSession === 'function' &&
    typeof switchModel === 'function';
  const pending = new Map<string, Promise<unknown>>();
  const cache = new Map<string, SessionPresetRecord>();
  const captured = new Map<string, SessionPresetProfile | null | undefined>();
  let retired = false;
  const key = (id: string) => `session-preset/v1/${id}`;

  function active(signal?: AbortSignal): void {
    if (retired) throw new Error('Session preset generation retired');
    signal?.throwIfAborted();
  }
  function required(): void {
    active();
    if (!available || !backend || !getSession || !switchModel) {
      throw new Error('Session presets require host storage and identity APIs');
    }
  }
  async function serial<T>(id: string, run: () => Promise<T>): Promise<T> {
    active();
    const task = (pending.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(() => {
        active();
        return run();
      });
    pending.set(id, task);
    try {
      return await task;
    } finally {
      if (pending.get(id) === task) pending.delete(id);
    }
  }
  async function identity(id: string, signal?: AbortSignal) {
    required();
    if (!getSession) throw new Error('Session identity API is unavailable');
    const response = await bounded(getSession({ sessionID: id }));
    active(signal);
    const info = (response as { data?: unknown }).data ?? response;
    if (!info || typeof info !== 'object' || Array.isArray(info)) {
      throw new Error('Session preset identity is malformed');
    }
    const value = info as Record<string, unknown>;
    const directory =
      (value.location as { directory?: unknown } | undefined)?.directory ??
      value.directory;
    if (
      value.id !== id ||
      typeof directory !== 'string' ||
      path.resolve(directory) !== path.resolve(options.directory)
    ) {
      throw new Error('Session preset session/location mismatch');
    }
    return value;
  }
  async function read(id: string): Promise<SessionPresetRecord | undefined> {
    required();
    if (!backend) throw new Error('Session preset storage is unavailable');
    const value = await bounded(backend.get(key(id)));
    active();
    if (value === undefined) {
      cache.delete(id);
      return undefined;
    }
    try {
      assertJson(value);
      const record = frozen(recordSchema.parse(value));
      cache.set(id, record);
      return record;
    } catch (error) {
      cache.delete(id);
      throw error;
    }
  }
  async function write(
    id: string,
    input: SessionPresetRecord,
    signal?: AbortSignal,
  ): Promise<SessionPresetRecord> {
    required();
    if (!backend) throw new Error('Session preset storage is unavailable');
    assertJson(input);
    const record = frozen(recordSchema.parse(input));
    active(signal);
    try {
      await bounded(backend.set(key(id), record));
    } catch (error) {
      cache.delete(id);
      throw error;
    }
    if (!retired) cache.set(id, record);
    active(signal);
    return record;
  }
  function selection(record: SessionPresetRecord | undefined) {
    return record?.execution ?? record?.bundle;
  }

  async function ensure(
    id: string,
    signal?: AbortSignal,
  ): Promise<SessionPresetAdmission | undefined> {
    if (!available) return undefined;
    return serial(id, async () => {
      const info = await identity(id, signal);
      let record = await read(id);
      const parentID =
        typeof info.parentID === 'string' ? info.parentID : undefined;
      if (record && record.parentID !== parentID) {
        throw new Error('Session preset parent identity mismatch');
      }
      if (!record && !parentID) {
        record = await write(
          id,
          { schemaVersion: 1, bundle: options.current() },
          signal,
        );
      }
      return {
        record,
        ...(parentID ? { parentID } : {}),
        ...(typeof info.agent === 'string' ? { agent: info.agent } : {}),
        ...(info.model !== undefined ? { model: info.model } : {}),
      };
    });
  }

  async function capture(id: string, admission?: SessionPresetAdmission) {
    if (captured.has(id)) return captured.get(id);
    const current = admission ?? (await ensure(id));
    if (!current) return null;
    const { record, parentID, agent } = current;
    if (!parentID || !agent || !options.agents.has(agent)) {
      captured.set(id, null);
      return null;
    }
    const profile = selection(record)?.profiles[agent];
    if (!profile) {
      captured.set(id, null);
      return null;
    }
    if (!switchModel) {
      throw new Error('Captured subagent requires a model switch API');
    }
    if (profile.model) {
      active();
      await bounded(
        switchModel.call(options.ctx.session, {
          sessionID: id,
          model: profile.model,
        }),
      );
      active();
    }
    captured.set(id, profile);
    return profile;
  }

  return {
    available,
    ensure,
    capture,
    profile: (id: string) => captured.get(id) ?? undefined,
    peek: (id: string) => cache.get(id),
    async state(id: string): Promise<SessionPresetState> {
      required();
      return serial(id, async () => {
        const info = await identity(id);
        const record = await read(id);
        const parentID =
          typeof info.parentID === 'string' ? info.parentID : undefined;
        if (record && record.parentID !== parentID) {
          throw new Error('Session preset parent identity mismatch');
        }
        return {
          presetName: record?.bundle.presetName ?? null,
          status: record ? 'bound' : 'unbound',
          affects: 'future-children-only',
        };
      });
    },
    async apply(id: string, name: string): Promise<SessionPresetState> {
      required();
      return serial(id, async () => {
        const info = await identity(id);
        const previous = await read(id);
        const parentID =
          typeof info.parentID === 'string' ? info.parentID : undefined;
        if (previous && previous.parentID !== parentID) {
          throw new Error('Session preset parent identity mismatch');
        }
        if (parentID && !previous) {
          throw new Error('Cannot bind a child without its launch snapshot');
        }
        const bundle = await options.named(name);
        active();
        const record = await write(id, {
          schemaVersion: 1,
          ...(parentID && previous
            ? {
                parentID,
                execution: previous.execution ?? previous.bundle,
              }
            : {}),
          bundle,
        });
        return {
          presetName: record.bundle.presetName,
          status: 'bound',
          affects: 'future-children-only',
        };
      });
    },
    async bindChild(input: {
      childID: string;
      parentID: string;
      bundle: SessionPresetBundle;
      execution?: SessionPresetBundle;
      signal?: AbortSignal;
    }): Promise<void> {
      required();
      await serial(input.childID, async () => {
        const info = await identity(input.childID, input.signal);
        if (info.parentID !== input.parentID) {
          throw new Error('Subagent parent identity mismatch');
        }
        const previous = await read(input.childID);
        if (previous) {
          if (
            previous.parentID !== input.parentID ||
            JSON.stringify(selection(previous)) !==
              JSON.stringify(input.execution ?? input.bundle)
          ) {
            throw new Error('Subagent preset snapshot conflicts with storage');
          }
          return;
        }
        await write(
          input.childID,
          {
            schemaVersion: 1,
            parentID: input.parentID,
            bundle: input.bundle,
            ...(input.execution ? { execution: input.execution } : {}),
          },
          input.signal,
        );
      });
    },
    async remove(id: string): Promise<void> {
      if (!available) return;
      await serial(id, async () => {
        active();
        if (!backend) throw new Error('Session preset storage is unavailable');
        await bounded(backend.remove(key(id)));
        active();
        cache.delete(id);
        captured.delete(id);
      });
    },
    async dispose(): Promise<void> {
      retired = true;
      await Promise.allSettled([...pending.values()]);
      pending.clear();
      cache.clear();
      captured.clear();
    },
  };
}

export type SessionPresetStore = ReturnType<typeof createSessionPresetStore>;

/** Apply only request-scoped inference fields. Never touch prompt or tools. */
export function applySessionPresetOptions(
  event: {
    model?: Record<string, unknown>;
    options?: Record<string, unknown>;
  },
  profile: SessionPresetProfile | undefined,
): void {
  const options = event.options;
  if (!profile || !options) return;
  if (profile.model && event.model?.providerID !== profile.model.providerID) {
    return;
  }
  for (const key of profile.managedOptionKeys) {
    delete options[key];
  }
  delete options.temperature;
  if (profile.temperature !== undefined) {
    options.temperature = profile.temperature;
  }
  for (const [key, value] of Object.entries(profile.options ?? {})) {
    if (key !== 'temperature') {
      options[key] = value;
    }
  }
}

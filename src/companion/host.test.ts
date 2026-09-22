import { describe, expect, test } from 'bun:test';
import { DESKTOP_HOST_KIND, describeHost } from './host';

describe('companion host descriptor', () => {
  test('recognises the desktop app and its bundle', () => {
    // The bundle id is what the companion falls back to for raising the app, so
    // a wrong value means a click silently does nothing.
    expect(describeHost('desktop')).toEqual({
      kind: DESKTOP_HOST_KIND,
      bundle_id: 'ai.opencode.desktop',
    });
  });

  test('the published keys are exactly what the companion deserializes', () => {
    // The companion reads this into a fixed struct that ignores unknown keys,
    // so a misspelled field is dropped rather than rejected: the host would
    // still be recognised while this field arrived empty. Pin the exact keys.
    const host = describeHost('desktop');
    expect(Object.keys(host ?? {}).sort()).toEqual(['bundle_id', 'kind']);
    // Every other field in the state file is snake_case too.
    expect(host?.bundle_id).toBe('ai.opencode.desktop');
  });

  test('tolerates casing and surrounding whitespace', () => {
    // `ctx.app.name` is host-supplied, so do not depend on its exact spelling.
    expect(describeHost('  Desktop ')).toEqual({
      kind: DESKTOP_HOST_KIND,
      bundle_id: 'ai.opencode.desktop',
    });
  });

  test('leaves other hosts undefined so a session can be opened', () => {
    // Every TUI-shaped host must keep the session path: claiming one of these
    // as desktop would silently replace navigation with a bare app focus.
    for (const name of ['tui', 'cli', 'server', 'opencode', 'web']) {
      expect(describeHost(name)).toBeUndefined();
    }
  });

  test('a missing host identity is not a desktop host', () => {
    // v1 hosts publish no app identity at all; they are TUI-shaped, so they
    // must keep the request channel rather than being treated as desktop.
    expect(describeHost(undefined)).toBeUndefined();
    expect(describeHost('')).toBeUndefined();
    expect(describeHost('   ')).toBeUndefined();
  });
});

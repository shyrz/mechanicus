import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  mutateJsonConfigFile,
  mutateJsonConfigText,
  parseJsonConfigText,
} from './json-file';

describe('JSONC config mutation', () => {
  test('keeps prototype-sensitive user keys as inert own properties', () => {
    const source = '{"__proto__":{"polluted":true},"preset":"old"}';
    const result = mutateJsonConfigText(source, (config) => ({
      ...config,
      preset: 'new',
    }));
    expect(Object.hasOwn(parseJsonConfigText(result), '__proto__')).toBe(true);
    expect(result).toContain('"__proto__":{"polluted":true}');
    expect(Object.hasOwn({}, 'polluted')).toBe(false);
  });
  test('preserves comments, unrelated fields, BOM and CRLF', () => {
    const source =
      '\uFEFF{\r\n  // selected team\r\n  "preset": "old",\r\n  /* keep agents */\r\n  "agents": {"dominus": {"model": "a/b"}},\r\n}\r\n';

    const result = mutateJsonConfigText(source, (config) => ({
      ...config,
      preset: 'cheap',
    }));

    expect(result.startsWith('\uFEFF')).toBe(true);
    expect(result).toContain('// selected team');
    expect(result).toContain('/* keep agents */');
    expect(result).toContain('"preset": "cheap"');
    expect(result).toContain('"agents": {"dominus": {"model": "a/b"}}');
    expect(result.replaceAll('\r\n', '')).not.toContain('\n');
    expect(parseJsonConfigText(result).agents).toEqual({
      dominus: { model: 'a/b' },
    });
  });

  test('changes only local preset fields, not inherited agent declarations', () => {
    const source = `{
      // shared models stay here
      "presets": {
        "base": {"dominus": {"model": "a/b"}},
        "child": {
          // local options only
          "extends": "base",
          "agents": {"magos": {"temperature": 0.2}},
        },
      },
    }`;

    const result = mutateJsonConfigText(source, (config) => {
      const presets = parseJsonConfigText(JSON.stringify(config.presets));
      presets.child = {
        extends: 'base',
        agents: { magos: { temperature: 0.3 } },
      };
      return { ...config, presets };
    });

    expect(result).toContain('// shared models stay here');
    expect(result).toContain('// local options only');
    expect(result).toContain('"base": {"dominus": {"model": "a/b"}}');
    expect(result).toContain('"temperature": 0.3');
    expect(result).not.toContain('"dominus": {\n');
  });

  test('can add and remove fields without discarding JSONC syntax', () => {
    const source = `{
      // keep this comment
      "preset": "base",
      "presets": {
        "base": {"magos": {"model": "a/b"}},
      },
    }`;

    const result = mutateJsonConfigText(source, (config) => {
      const next = { ...config };
      delete next.preset;
      next.presets = {};
      return next;
    });

    expect(result).toContain('// keep this comment');
    expect(result).not.toContain('"preset"');
    expect(parseJsonConfigText(result).presets).toEqual({});
  });

  test('rejects invalid JSONC and non-object roots', () => {
    expect(() => parseJsonConfigText('{"preset": broken}')).toThrow(
      'Invalid JSONC config',
    );
    expect(() => parseJsonConfigText('[]')).toThrow('JSON object');
    expect(() => parseJsonConfigText('{"preset":"a","preset":"b"}')).toThrow(
      'Duplicate',
    );
  });

  test.each([
    '{/* before */"a":1, /* next */ "b":2}',
    '{"a":1, /* last */ "b":2 /* end */}',
    '{/* only */ "a":1, /* end */}',
    '{"a":{"nested": [1,2]}, /* next */ "b":2,}',
  ])('removes a field without deleting adjacent comments: %s', (source) => {
    const result = mutateJsonConfigText(source, (config) => {
      delete config.a;
      return config;
    });
    expect(parseJsonConfigText(result).a).toBeUndefined();
    for (const comment of source.match(/\/\*.*?\*\//g) ?? []) {
      expect(result).toContain(comment);
    }
  });

  test('atomic file writes keep mode and reject a disk edit during mutation', () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'mechanicus-jsonc-'),
    );
    try {
      const file = path.join(directory, 'config.jsonc');
      fs.writeFileSync(file, '{"preset":"old"}', { mode: 0o600 });
      mutateJsonConfigFile(file, (config) => ({ ...config, preset: 'new' }));
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      const external = '{"preset":"external"}';
      expect(() =>
        mutateJsonConfigFile(file, (config) => {
          fs.writeFileSync(file, external);
          return { ...config, preset: 'editor' };
        }),
      ).toThrow('Config changed while saving');
      expect(fs.readFileSync(file, 'utf8')).toBe(external);
      expect(fs.readdirSync(directory)).toEqual(['config.jsonc']);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PresetInput } from '../config';
import { parseJsonConfigText } from '../config/json-file';
import {
  deletePresetWithResult,
  findPresetDependents,
  switchPresetOnDisk,
  wouldCreatePresetCycle,
  writePresetWithResult,
} from './preset-switch';

let temporary: string;
let originalConfigDirectory: string | undefined;
let configPath: string;

function writeConfig(source: string): void {
  fs.writeFileSync(configPath, source);
}

function readConfig(): Record<string, unknown> {
  return parseJsonConfigText(fs.readFileSync(configPath, 'utf8'));
}

beforeEach(() => {
  originalConfigDirectory = process.env.OPENCODE_CONFIG_DIR;
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mechanicus-stage-c-'));
  process.env.OPENCODE_CONFIG_DIR = temporary;
  configPath = path.join(temporary, 'mechanicus.jsonc');
});

afterEach(() => {
  if (originalConfigDirectory === undefined) {
    delete process.env.OPENCODE_CONFIG_DIR;
  } else {
    process.env.OPENCODE_CONFIG_DIR = originalConfigDirectory;
  }
  fs.rmSync(temporary, { recursive: true, force: true });
});

describe('preset editing persistence', () => {
  test('does not claim a global selection masked by project config', () => {
    const source = '{"preset": "old"}';
    writeConfig(source);
    fs.mkdirSync(path.join(temporary, '.opencode'));
    fs.writeFileSync(
      path.join(temporary, '.opencode/mechanicus.json'),
      '{"preset":"project"}',
    );
    const result = switchPresetOnDisk(temporary, 'cheap', {
      presets: { cheap: { magos: { model: 'cheap/model' } } },
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('Project config');
    expect(fs.readFileSync(configPath, 'utf8')).toBe(source);
  });

  test('can apply a preset containing only non-model agent overrides', () => {
    writeConfig('{}');
    const result = switchPresetOnDisk(temporary, 'inherit', {
      presets: {
        inherit: { magos: { inheritModelFrom: 'session', skills: ['test'] } },
      },
    });
    expect(result.ok).toBe(true);
    expect(readConfig().preset).toBe('inherit');
  });

  test('refuses parent deletion when a project preset depends on it', () => {
    const source = '{"presets":{"base":{"magos":{"model":"a/b"}}}}';
    writeConfig(source);
    fs.mkdirSync(path.join(temporary, '.opencode'));
    fs.writeFileSync(
      path.join(temporary, '.opencode/mechanicus.json'),
      '{"presets":{"project-child":{"extends":"base","agents":{}}}}',
    );
    const result = deletePresetWithResult(temporary, 'base');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('project-child');
    expect(fs.readFileSync(configPath, 'utf8')).toBe(source);
  });

  test('preserves JSONC comments and symlink targets when applying', () => {
    const target = path.join(temporary, 'dotfiles.jsonc');
    const source = `{
      // retain the active-team explanation
      "preset": "old",
      "agents": {"magos": {"model": "root/model"}},
    }`;
    fs.writeFileSync(target, source);
    fs.symlinkSync('dotfiles.jsonc', configPath);

    const result = switchPresetOnDisk(temporary, 'cheap', {
      presets: { cheap: { magos: { model: 'cheap/model' } } },
    });

    expect(result.ok).toBe(true);
    expect(fs.lstatSync(configPath).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toContain(
      '// retain the active-team explanation',
    );
    expect(fs.readFileSync(target, 'utf8')).toContain('"preset": "cheap"');
  });

  test('refuses to delete a parent with dependents without writing', () => {
    const source = `{
      "preset": "child",
      "presets": {
        "base": {"magos": {"model": "base/model"}},
        "child": {"extends": "base", "agents": {}},
      },
    }`;
    writeConfig(source);

    const result = deletePresetWithResult(temporary, 'base');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('child');
    expect(fs.readFileSync(configPath, 'utf8')).toBe(source);
  });

  test('deletes a leaf preset and clears only its active selection', () => {
    writeConfig(`{
      "preset": "leaf",
      // keep the base
      "presets": {
        "base": {"magos": {"model": "base/model"}},
        "leaf": {"extends": "base", "agents": {}},
      },
    }`);

    expect(deletePresetWithResult(temporary, 'leaf').ok).toBe(true);
    const persisted = readConfig();
    expect(persisted.preset).toBeUndefined();
    expect(persisted.presets).toEqual({
      base: { magos: { model: 'base/model' } },
    });
    expect(fs.readFileSync(configPath, 'utf8')).toContain('// keep the base');
  });

  test('rejects inheritance cycles before writing', () => {
    const source = JSON.stringify({
      presets: {
        parent: { extends: 'child', agents: {} },
        child: { extends: 'parent', agents: {} },
      },
    });
    writeConfig(source);

    const result = writePresetWithResult(temporary, 'child', {
      extends: 'parent',
      agents: { magos: { model: 'local/model' } },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('cycle');
    expect(fs.readFileSync(configPath, 'utf8')).toBe(source);
  });

  test('saves structured local deltas without flattening the parent', () => {
    writeConfig(`{
      "presets": {
        "base": {"magos": {"model": "base/model"}},
        "child": {"extends": "base", "agents": {"magos": {"variant": "low"}}},
      },
    }`);

    expect(
      writePresetWithResult(temporary, 'child', {
        extends: 'base',
        agents: { magos: { temperature: 0.1 } },
      }).ok,
    ).toBe(true);

    expect(readConfig().presets).toEqual({
      base: { magos: { model: 'base/model' } },
      child: { extends: 'base', agents: { magos: { temperature: 0.1 } } },
    });
  });

  test('validates a proposed parent against existing ancestry', () => {
    const presets: Record<string, PresetInput> = {
      root: { magos: { model: 'base/model' } },
      middle: { extends: 'root', agents: {} },
      child: { extends: 'middle', agents: {} },
    };

    expect(wouldCreatePresetCycle('root', 'child', presets)).toBe(true);
    expect(findPresetDependents('middle', presets)).toEqual(['child']);
    expect(wouldCreatePresetCycle('child', 'root', presets)).toBe(false);
  });
});

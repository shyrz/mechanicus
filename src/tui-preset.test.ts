import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TuiPluginApi } from '@opencode-ai/plugin/tui';
import { parseJsonConfigText } from './config/json-file';
import { openPresetManager } from './tui-preset';
import type { TuiSnapshot } from './tui-state';

let directory: string;
let previousConfigDir: string | undefined;

const snapshot: TuiSnapshot = {
  version: 1,
  updatedAt: 0,
  agentModels: {},
  agentVariants: {},
  activeSessions: {},
  activityPids: {},
  sessionParents: {},
  sessionDetails: {},
  reusableByAgent: {},
};

interface SelectProps {
  title: string;
  options: Array<{ title: string; value: string; description?: string }>;
  onSelect: (option: { value: string }) => void;
}

function dialogDriver() {
  let render: () => unknown = () => undefined;
  let select: SelectProps;
  let confirm: { onConfirm: () => void };
  const toasts: Array<{ title?: string; message?: string }> = [];
  const api = {
    ui: {
      dialog: {
        replace: (next: () => unknown) => {
          render = next;
        },
        clear: () => {},
      },
      Dialog: (props: unknown) => props,
      DialogSelect: (props: SelectProps) => {
        select = props;
        return props;
      },
      DialogConfirm: (props: typeof confirm) => {
        confirm = props;
        return props;
      },
      DialogPrompt: (props: unknown) => props,
      toast: (toast: (typeof toasts)[number]) => toasts.push(toast),
    },
  } as unknown as TuiPluginApi;
  return {
    api,
    toasts,
    current: () => {
      render();
      return select;
    },
    choose: (title: string) => {
      render();
      const option = select.options.find((option) => option.title === title);
      if (!option) throw new Error(`Missing option ${title}`);
      select.onSelect(option);
    },
    confirm: () => {
      render();
      confirm.onConfirm();
    },
  };
}

function configFile(): string {
  return path.join(directory, 'mechanicus.jsonc');
}

function writePresets(): void {
  fs.writeFileSync(
    configFile(),
    `{
    // preserve this explanation
    "presets": {
      "base": {"dominus": {"model": "base/model"}},
      "child": {"extends": "base", "agents": {"magos": {"temperature": 0.2}}},
      "leaf": {"extends": "child", "agents": {}},
    },
  }`,
  );
}

beforeEach(() => {
  previousConfigDir = process.env.OPENCODE_CONFIG_DIR;
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mechanicus-preset-tui-'));
  process.env.OPENCODE_CONFIG_DIR = directory;
  writePresets();
});

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
  else process.env.OPENCODE_CONFIG_DIR = previousConfigDir;
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('preset inheritance editor', () => {
  test('shows inherited agents read-only and saves only local deltas', () => {
    const driver = dialogDriver();
    openPresetManager(driver.api, directory, { snapshot });
    driver.choose('child');
    driver.choose('Edit agents');
    expect(driver.current().title).toBe('Edit preset: child');
    expect(driver.current().options.map((option) => option.title)).toContain(
      'Base preset: base',
    );
    driver.choose('dominus (inherited from base)');
    expect(driver.toasts.at(-1)?.title).toBe('Inherited agent');
    expect(driver.current().title).toBe('Edit preset: child');
    driver.choose('💾 Save');
    expect(driver.toasts.at(-1)?.title).toBe('Preset saved');
    expect(
      parseJsonConfigText(fs.readFileSync(configFile(), 'utf8')).presets,
    ).toEqual({
      base: { dominus: { model: 'base/model' } },
      child: { extends: 'base', agents: { magos: { temperature: 0.2 } } },
      leaf: { extends: 'child', agents: {} },
    });
    expect(fs.readFileSync(configFile(), 'utf8')).toContain(
      '// preserve this explanation',
    );
  });

  test('base picker omits self and descendants, and can remove inheritance', () => {
    const driver = dialogDriver();
    openPresetManager(driver.api, directory, { snapshot });
    driver.choose('child');
    driver.choose('Edit agents');
    driver.choose('Base preset: base');
    expect(driver.current().options.map((option) => option.title)).toEqual([
      '(none)',
      'base',
      '← Back',
    ]);
    driver.choose('(none)');
    driver.choose('💾 Save');
    expect(driver.toasts.at(-1)?.title).toBe('Preset saved');
    expect(
      parseJsonConfigText(fs.readFileSync(configFile(), 'utf8')).presets,
    ).toMatchObject({
      child: { magos: { temperature: 0.2 } },
    });
  });

  test('delete parent reports the dependent name and writes nothing', () => {
    const before = fs.readFileSync(configFile(), 'utf8');
    const driver = dialogDriver();
    openPresetManager(driver.api, directory, { snapshot });
    driver.choose('base');
    driver.choose('Delete preset');
    driver.confirm();
    expect(driver.toasts.at(-1)?.title).toBe('Delete failed');
    expect(driver.toasts.at(-1)?.message).toContain('child');
    expect(fs.readFileSync(configFile(), 'utf8')).toBe(before);
  });

  test('refuses stale editor saves and leaves newer disk changes intact', () => {
    const driver = dialogDriver();
    openPresetManager(driver.api, directory, { snapshot });
    driver.choose('child');
    driver.choose('Edit agents');
    const before = fs.readFileSync(configFile(), 'utf8').replace('0.2', '0.4');
    fs.writeFileSync(configFile(), before);
    driver.choose('💾 Save');
    expect(driver.toasts.at(-1)?.title).toBe('Save failed');
    expect(driver.toasts.at(-1)?.message).toContain('changed while editing');
    expect(fs.readFileSync(configFile(), 'utf8')).toBe(before);
  });

  test('never materializes project overrides into a user declaration', () => {
    const local = path.join(directory, '.opencode');
    fs.mkdirSync(local);
    const project = JSON.stringify({
      presets: { child: { agents: { magos: { model: 'project/model' } } } },
    });
    fs.writeFileSync(path.join(local, 'mechanicus.json'), project);
    const driver = dialogDriver();
    openPresetManager(driver.api, directory, { snapshot });
    driver.choose('child');
    driver.choose('Edit agents');
    driver.choose('💾 Save');
    expect(driver.toasts.at(-1)?.title).toBe('Preset saved');
    expect(fs.readFileSync(configFile(), 'utf8')).not.toContain(
      'project/model',
    );
    expect(fs.readFileSync(path.join(local, 'mechanicus.json'), 'utf8')).toBe(
      project,
    );
  });
});

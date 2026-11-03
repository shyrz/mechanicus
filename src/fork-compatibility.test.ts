import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import packageJson from '../package.json';
import { createAgents } from './agents';
import { getLiteConfig, getLiteConfigJsonc } from './cli/paths';
import { commandFilePath } from './companion/command';
import { CompanionManager, stateFilePath } from './companion/manager';
import {
  AGENT_ALIASES,
  ALL_AGENT_NAMES,
  isPrimaryAgentName,
  lookupAgentEntry,
} from './config/constants';
import { CouncilConfigSchema } from './config/council-schema';
import { RuntimeConfig } from './config/runtime';

const TEST_DIRECTORY = 'fork-compatibility-test';
const ORIGINAL_ENV = { ...process.env };

describe('mechanicus fork compatibility', () => {
  beforeEach(() => {
    process.env.OPENCODE_CONFIG_DIR = '/tmp/mechanicus-fork-contract';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    RuntimeConfig.reset(TEST_DIRECTORY);
  });

  test('keeps the package, schema, and user configuration identities', () => {
    expect(packageJson.name).toBe('mechanicus');
    expect(packageJson.bin).toEqual({
      mechanicus: './dist/cli/index.js',
    });
    expect(packageJson.files).toContain('mechanicus.schema.json');
    expect(getLiteConfig()).toBe(
      '/tmp/mechanicus-fork-contract/mechanicus.json',
    );
    expect(getLiteConfigJsonc()).toBe(
      '/tmp/mechanicus-fork-contract/mechanicus.jsonc',
    );
  });

  test('retains canonical agent names and accepts every legacy alias', () => {
    expect(ALL_AGENT_NAMES).toEqual([
      'omnissiah',
      'magos',
      'logis',
      'dominus',
      'artisan',
      'genetor',
      'observer',
      'council',
      'councillor',
    ]);
    expect(isPrimaryAgentName('omnissiah')).toBe(true);
    expect(isPrimaryAgentName('orchestrator')).toBe(true);

    for (const [alias, canonical] of Object.entries(AGENT_ALIASES)) {
      expect(lookupAgentEntry({ [alias]: 'legacy' }, canonical)).toBe('legacy');
    }
    expect(
      lookupAgentEntry({ explorer: 'legacy', magos: 'canonical' }, 'magos'),
    ).toBe('canonical');
  });

  test('registers canonical agents from legacy configuration keys', () => {
    RuntimeConfig.init(TEST_DIRECTORY, {
      disabled_agents: [],
      council: CouncilConfigSchema.parse({
        presets: { default: { alpha: { model: 'test/councillor' } } },
      }),
      agents: {
        orchestrator: { model: 'test/primary' },
        explorer: { model: 'test/explorer' },
      },
    });

    const agents = createAgents(RuntimeConfig.get(TEST_DIRECTORY));
    for (const name of ALL_AGENT_NAMES) {
      expect(agents.some((agent) => agent.name === name)).toBe(true);
    }
    expect(
      agents.find((agent) => agent.name === 'omnissiah')?.config.model,
    ).toBe('test/primary');
    expect(agents.find((agent) => agent.name === 'magos')?.config.model).toBe(
      'test/explorer',
    );
  });
});

describe('companion fork compatibility', () => {
  let directory: string;
  let manager: CompanionManager | undefined;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'mechanicus-fork-companion-'));
    process.env.XDG_DATA_HOME = directory;
  });

  afterEach(() => {
    manager?.onExit();
    manager = undefined;
    process.env = { ...ORIGINAL_ENV };
    rmSync(directory, { recursive: true, force: true });
  });

  test('keeps the filesystem navigation contract used by both companions', () => {
    const file = commandFilePath();
    expect(file).toBe(
      join(directory, 'opencode/storage/mechanicus/companion-command.json'),
    );

    const request = {
      version: 1,
      action: 'navigate',
      sessionID: 'session-to-open',
      cwd: '/project',
      requestedAt: Date.now(),
    };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(request));
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(request);
  });

  test('keeps accepting the primary alias and cleaning up on host exit', () => {
    manager = new CompanionManager('parent-session', '/project', {
      enabled: true,
      position: 'bottom-right',
      size: 'medium',
    });
    manager.onLoad();
    manager.onSessionStatus({
      sessionId: 'child-session',
      agent: 'orchestrator',
      status: 'busy',
    });

    let state = JSON.parse(readFileSync(stateFilePath(), 'utf8'));
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0].active_agents).toContain('omnissiah');
    expect(state.sessions[0].status).toBe('busy');

    manager.onExit();
    manager = undefined;
    state = JSON.parse(readFileSync(stateFilePath(), 'utf8'));
    expect(state.sessions).toEqual([]);
    expect(existsSync(join(dirname(stateFilePath()), 'companion.pid'))).toBe(
      false,
    );
  });
});

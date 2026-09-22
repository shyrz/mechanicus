import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  claimNavigation,
  commandFilePath,
  NAVIGATE_GRACE_MS,
  NAVIGATE_TTL_MS,
  type NavigateCommand,
  readCommand,
} from './command';

const REQUESTED_AT = 1_000_000;
const ALPHA = '/projects/alpha';
const BETA = '/projects/beta';

function navigateCommand(
  overrides: Partial<NavigateCommand> = {},
): Record<string, unknown> {
  return {
    version: 1,
    action: 'navigate',
    sessionID: 'sess-1',
    cwd: ALPHA,
    requestedAt: REQUESTED_AT,
    ...overrides,
  };
}

function writeCommand(value: unknown): string {
  const file = commandFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

describe('companion command channel', () => {
  const originalXdgDataHome = process.env.XDG_DATA_HOME;
  let stateDirectory: string;

  beforeEach(() => {
    stateDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'mechanicus-command-state-'),
    );
    process.env.XDG_DATA_HOME = stateDirectory;
  });

  afterEach(() => {
    fs.rmSync(stateDirectory, { recursive: true, force: true });
    if (originalXdgDataHome === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = originalXdgDataHome;
    }
  });

  test('there is nothing to claim without a request', () => {
    expect(readCommand(REQUESTED_AT)).toBeUndefined();
    expect(claimNavigation(ALPHA, REQUESTED_AT)).toBeUndefined();
  });

  test('the requesting project claims its own request', () => {
    writeCommand(navigateCommand());

    expect(claimNavigation(ALPHA, REQUESTED_AT + 1)).toEqual({
      version: 1,
      action: 'navigate',
      sessionID: 'sess-1',
      cwd: ALPHA,
      requestedAt: REQUESTED_AT,
    });
  });

  test('a claim is single use', () => {
    writeCommand(navigateCommand());

    expect(claimNavigation(ALPHA, REQUESTED_AT + 1)).toBeDefined();
    expect(claimNavigation(ALPHA, REQUESTED_AT + 2)).toBeUndefined();
    expect(fs.existsSync(commandFilePath())).toBe(false);
  });

  test('reading does not consume, so a claim can still follow', () => {
    writeCommand(navigateCommand());

    expect(readCommand(REQUESTED_AT + 1)).toBeDefined();
    expect(fs.existsSync(commandFilePath())).toBe(true);
    expect(claimNavigation(ALPHA, REQUESTED_AT + 2)).toBeDefined();
  });

  test('another project waits for the grace window', () => {
    writeCommand(navigateCommand());

    expect(claimNavigation(BETA, REQUESTED_AT + 1)).toBeUndefined();
    // Untouched, so the project that asked still gets its chance.
    expect(fs.existsSync(commandFilePath())).toBe(true);
    expect(readCommand(REQUESTED_AT + 1)).toBeDefined();
  });

  test('another project may take over once the grace window passes', () => {
    writeCommand(navigateCommand());

    const after = REQUESTED_AT + NAVIGATE_GRACE_MS + 1;
    expect(claimNavigation(BETA, after)).toBeDefined();
  });

  test('a stale request is discarded rather than answered late', () => {
    writeCommand(navigateCommand());

    const late = REQUESTED_AT + NAVIGATE_TTL_MS + 1;
    expect(readCommand(late)).toBeUndefined();
    expect(fs.existsSync(commandFilePath())).toBe(false);
    expect(claimNavigation(ALPHA, late)).toBeUndefined();
  });

  test('a request exactly at the TTL boundary is still honoured', () => {
    writeCommand(navigateCommand());

    const boundary = REQUESTED_AT + NAVIGATE_TTL_MS;
    expect(claimNavigation(ALPHA, boundary)).toBeDefined();
  });

  test('a half-written file is ignored but left for the writer', () => {
    const file = commandFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"version":1,"action":"navig');

    expect(readCommand(REQUESTED_AT)).toBeUndefined();
    expect(claimNavigation(ALPHA, REQUESTED_AT)).toBeUndefined();
    expect(fs.existsSync(file)).toBe(true);
  });

  test('malformed requests are rejected', () => {
    const rejected: unknown[] = [
      navigateCommand({ version: 2 as never }),
      navigateCommand({ action: 'other' as never }),
      navigateCommand({ sessionID: '' }),
      navigateCommand({ sessionID: 42 as never }),
      navigateCommand({ cwd: 42 as never }),
      navigateCommand({ requestedAt: 'now' as never }),
      navigateCommand({ requestedAt: Number.NaN }),
      [],
      'navigate',
      null,
    ];

    for (const value of rejected) {
      writeCommand(value);
      expect(readCommand(REQUESTED_AT)).toBeUndefined();
      expect(claimNavigation(ALPHA, REQUESTED_AT)).toBeUndefined();
    }
  });

  test('one window wins a race for the same request', () => {
    writeCommand(navigateCommand());

    const claims = [
      claimNavigation(ALPHA, REQUESTED_AT + 1),
      claimNavigation(ALPHA, REQUESTED_AT + 1),
      claimNavigation(ALPHA, REQUESTED_AT + 1),
    ].filter((command) => command !== undefined);

    expect(claims).toHaveLength(1);
  });

  test('a claimed request leaves no litter behind', () => {
    const file = commandFilePath();
    writeCommand(navigateCommand());
    claimNavigation(ALPHA, REQUESTED_AT + 1);

    const leftovers = fs
      .readdirSync(path.dirname(file))
      .filter((name) => name.startsWith('companion-command'));

    expect(leftovers).toEqual([]);
  });
});

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Companion → plugin requests.
 *
 * The companion is a detached process with no IPC to the plugin, so the
 * filesystem is the entire contract. State flows plugin → companion through
 * `companion-state.json`; this module carries the rare request in the other
 * direction, which is what lets a click on the companion ask a TUI to open a
 * session.
 *
 * A request is single-use. Claiming one is an atomic rename, so when several
 * windows poll the same file exactly the one that wins the rename handles it
 * and the rest see it gone and move on — the same trick the state-file lock
 * uses. Nothing here may write `companion-state.json`: that file belongs to the
 * plugin, and the companion's read-only contract with it is what lets the
 * original and Tauri implementations coexist.
 */

/**
 * Window in which only a TUI showing the requesting project may claim.
 *
 * A companion belongs to a project, so its own window should be the one that
 * answers. If none does — the user happens to be looking at another project —
 * any window may take it once this has passed, because landing in the right
 * project still beats a click that silently does nothing.
 */
export const NAVIGATE_GRACE_MS = 400;

/** How long a request stays valid before it is discarded as stale. */
export const NAVIGATE_TTL_MS = 3000;

export interface NavigateCommand {
  version: 1;
  action: 'navigate';
  /** Session to open. */
  sessionID: string;
  /** Project the request came from, used to prefer its own window. */
  cwd: string;
  requestedAt: number;
}

function dataDirectory(): string {
  const xdg = process.env.XDG_DATA_HOME?.trim();
  return xdg && path.isAbsolute(xdg)
    ? xdg
    : path.join(os.homedir(), '.local', 'share');
}

/** Sits beside `companion-state.json`, in the plugin's storage directory. */
export function commandFilePath(): string {
  return path.join(
    dataDirectory(),
    'opencode',
    'storage',
    'mechanicus',
    'companion-command.json',
  );
}

function parseCommand(raw: unknown): NavigateCommand | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const value = raw as Partial<NavigateCommand>;
  if (value.version !== 1 || value.action !== 'navigate') return undefined;
  if (typeof value.sessionID !== 'string' || value.sessionID === '') {
    return undefined;
  }
  if (typeof value.cwd !== 'string') return undefined;
  if (
    typeof value.requestedAt !== 'number' ||
    !Number.isFinite(value.requestedAt)
  ) {
    return undefined;
  }
  return {
    version: 1,
    action: 'navigate',
    sessionID: value.sessionID,
    cwd: value.cwd,
    requestedAt: value.requestedAt,
  };
}

/** Best-effort unlink; another window may have removed it already. */
function discard(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    // Gone, or owned by someone else now.
  }
}

/**
 * Reads the pending request, if it is still worth acting on.
 *
 * A malformed file is ignored rather than deleted: a half-written one is
 * transient, and the writer replaces it atomically.
 */
export function readCommand(now = Date.now()): NavigateCommand | undefined {
  const file = commandFilePath();
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }

  const command = parseCommand(raw);
  if (command === undefined) return undefined;

  // A request nobody could answer is not worth answering late: by the time a
  // window shows up it may be a different session entirely.
  if (now - command.requestedAt > NAVIGATE_TTL_MS) {
    discard(file);
    return undefined;
  }
  return command;
}

/**
 * Claims the pending request for this window, if it should handle it.
 *
 * Returns the request exactly once across all windows, or `undefined` when
 * there is nothing to do. Callers navigate when this returns a request.
 */
export function claimNavigation(
  directory: string,
  now = Date.now(),
): NavigateCommand | undefined {
  const command = readCommand(now);
  if (command === undefined) return undefined;

  if (
    command.cwd !== directory &&
    now - command.requestedAt < NAVIGATE_GRACE_MS
  ) {
    return undefined;
  }

  const file = commandFilePath();
  const claimed = `${file}.${process.pid}.${randomUUID()}.claimed`;
  try {
    // Whoever wins this rename owns the request; a loser gets ENOENT.
    fs.renameSync(file, claimed);
  } catch {
    return undefined;
  }
  discard(claimed);
  return command;
}

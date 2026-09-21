// Agent names
export const AGENT_ALIASES: Record<string, string> = {
  // Legacy aliases: agents renamed to their current canonical names. User
  // config, prompt files, and historical sessions written against the old
  // names keep working through these mappings.
  explore: 'magos',
  'frontend-ui-ux-engineer': 'artisan',
  orchestrator: 'omnissiah',
  explorer: 'magos',
  librarian: 'logis',
  oracle: 'dominus',
  designer: 'artisan',
  fixer: 'genetor',
};

/**
 * Legacy aliases ordered by recency, most recent first. When several aliases
 * resolve to the same canonical name (e.g. both `explore` and `explorer` map
 * to `magos`), reverse lookups must prefer the most recent one, because that
 * is the name users most likely wrote in their current config.
 */
export const AGENT_ALIAS_PRIORITY: readonly string[] = [
  'explorer',
  'librarian',
  'oracle',
  'designer',
  'fixer',
  'orchestrator',
  'explore',
  'frontend-ui-ux-engineer',
];

/**
 * All legacy aliases resolving to `name`, ordered most recent first.
 * Empty when `name` is not a canonical agent name (or has no aliases).
 */
export function aliasesForAgent(name: string): string[] {
  return AGENT_ALIAS_PRIORITY.filter((alias) => AGENT_ALIASES[alias] === name);
}

/**
 * Alias-aware lookup in a record keyed by agent name. Prefers the canonical
 * key, then each legacy alias in recency order. This is the single source of
 * truth for the "canonical first, then newest alias" rule that every
 * override-lookup site must follow.
 *
 * `name` may itself be a legacy alias: it is normalized to the canonical name
 * first, so callers that iterate a record's own keys (which may be written in
 * any historical spelling) resolve correctly in both directions.
 */
export function lookupAgentEntry<T>(
  record: Record<string, T> | undefined,
  name: string,
): T | undefined {
  if (!record) return undefined;
  // Normalize an incoming alias to its canonical name before probing, so a
  // record keyed by 'genetor' is found when the caller asks for 'fixer' too.
  const canonicalName = AGENT_ALIASES[name] ?? name;
  // Canonical first: when a record carries both spellings, the current name
  // is authoritative over any historical one.
  const canonical = record[canonicalName];
  if (canonical !== undefined) return canonical;
  // Then the exact key the caller asked for (differs from canonicalName only
  // when `name` was an alias), so records keyed by a legacy name still hit.
  const direct = record[name];
  if (direct !== undefined) return direct;
  for (const alias of aliasesForAgent(canonicalName)) {
    const hit = record[alias];
    if (hit !== undefined) return hit;
  }
  return undefined;
}

export const SUBAGENT_NAMES = [
  'magos',
  'logis',
  'dominus',
  'artisan',
  'genetor',
  'observer',
  'council',
  'councillor',
] as const;

/** Canonical name of the primary (orchestrating) agent. */
export const PRIMARY_AGENT_NAME = 'omnissiah' as const;

/** Legacy alias for the primary agent, still accepted in user config. */
export const PRIMARY_AGENT_ALIAS = 'orchestrator' as const;

/**
 * True when the given agent name is the primary agent, accepting both the
 * canonical name and its legacy alias. Use this when matching agent names
 * that may originate from historical sessions or user config; use a strict
 * `=== PRIMARY_AGENT_NAME` comparison when constructing agent definitions.
 */
export function isPrimaryAgentName(name: string | undefined): boolean {
  return name === PRIMARY_AGENT_NAME || name === PRIMARY_AGENT_ALIAS;
}

export const ALL_AGENT_NAMES = ['omnissiah', ...SUBAGENT_NAMES] as const;

// Agent name type (for use in DEFAULT_MODELS)
export type AgentName = (typeof ALL_AGENT_NAMES)[number];

export const AGENT_THEME_COLORS = [
  'primary',
  'secondary',
  'accent',
  'success',
  'warning',
  'error',
  'info',
] as const;

/**
 * Agents that cannot be disabled even if listed in disabled_agents config.
 * Accepts both the canonical primary name and its legacy alias.
 */
export const PROTECTED_AGENTS = new Set([
  PRIMARY_AGENT_NAME,
  PRIMARY_AGENT_ALIAS,
  'councillor',
]);

/**
 * Default models for each agent.
 * All set to undefined so agents follow the global/session model.
 * Users can override per-agent via mechanicus.json agents.<name>.model.
 */
export const DEFAULT_MODELS: Record<AgentName, string | undefined> = {
  omnissiah: undefined,
  dominus: undefined,
  logis: undefined,
  magos: undefined,
  artisan: undefined,
  genetor: undefined,
  observer: undefined,
  council: undefined,
  councillor: undefined,
};

// Polling configuration
export const POLL_INTERVAL_MS = 500;
export const POLL_INTERVAL_BACKGROUND_MS = 2000;

// Timeouts
export const MAX_POLL_TIME_MS = 5 * 60 * 1000; // 5 minutes

// Workflow reminders
export const PHASE_REMINDER_TEXT = `!IMPORTANT! Scheduler workflow: First choose the lightest workflow that fits the work. If direct execution is justified, complete it and verify proportionately. Otherwise: plan lanes/dependencies → dispatch background specialists → track task IDs → wait for hook-driven completion → reconcile terminal results → verify. !END!`;

export function formatSystemReminder(text: string): string {
  return `<system-reminder>\n${text}\n</system-reminder>`;
}

export const PHASE_REMINDER = formatSystemReminder(PHASE_REMINDER_TEXT);

export const WRITABLE_FILE_OPERATIONS_RULES = `**File Operations Rules**:
- Prefer dedicated file tools for normal code work: glob/grep/ast_grep_search for discovery, read for file contents, and edit/write/apply_patch for targeted source changes.
- Use bash for execution and automation: git, package managers, tests, builds, scripts, diagnostics, and shell-native filesystem operations.
- Shell is acceptable for bulk or mechanical filesystem changes when it is clearer or safer than many individual edits (for example: truncate generated logs, remove build artifacts, batch rename/move files), especially when the user explicitly asks for that shell operation.
- Before destructive or broad shell operations, verify the target set and quote paths. Prefer a dry-run/listing first when practical.
- Do not use cat/head/tail/sed/awk only to read code into context; use read/grep unless a shell pipeline is genuinely the better diagnostic.`;

export const READONLY_FILE_OPERATIONS_RULES = `**File Operations Rules**:
- READ-ONLY: inspect and report; do not modify files.
- Prefer dedicated file tools for codebase inspection: glob/grep/ast_grep_search for discovery and read for file contents.
- Bash is allowed for non-mutating diagnostics and shell-native inspection when it is the clearest tool, but not for modifying files.
- Do not use cat/head/tail/sed/awk only to read code into context; use read/grep unless a shell pipeline is genuinely the better diagnostic.`;

export const NO_SHELL_READONLY_FILE_OPERATIONS_RULES = `**File Operations Rules**:
- READ-ONLY: inspect and report; do not modify files.
- Use glob/grep/ast_grep_search for discovery and read for file contents.
- Do not use bash or shell commands.`;

// Polling stability
export const STABLE_POLLS_THRESHOLD = 3;

// Toast duration (ms) used by all Mechanicus toasts
export const TOAST_DURATION_MS = 10_000;

/** Agents that are disabled by default. Users must explicitly enable them
 *  by removing from disabled_agents and configuring an appropriate model. */
export const DEFAULT_DISABLED_AGENTS: string[] = ['observer'];

// Background job defaults
export const DEFAULT_MAX_SESSIONS_PER_AGENT = 2;
export const DEFAULT_MAX_CONTEXT_LINES = 50_000;
export const DEFAULT_READ_CONTEXT_MIN_LINES = 10;
export const DEFAULT_READ_CONTEXT_MAX_FILES = 8;
export const DEFAULT_MAX_RETAINED_SNAPSHOTS = 20;

/**
 * Maximum session metadata entries retained per plugin instance.
 * Prevents unbounded growth when session.deleted events are missed.
 * Oldest entries are evicted first when this threshold is reached.
 */
export const DEFAULT_MAX_SESSION_METADATA_ENTRIES = 1000;

export type ImageRouting = 'auto' | 'direct';

export function resolveImageRouting(
  imageRouting: ImageRouting | undefined,
  observerEnabled: boolean,
): ImageRouting {
  // Explicit value: use it
  if (imageRouting !== undefined) return imageRouting;
  // Legacy conditional: intercept only when observer is enabled
  return observerEnabled ? 'auto' : 'direct';
}

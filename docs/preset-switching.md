# Preset Switching

Switch agent model presets at runtime using the `/preset` TUI slash command.

## Controls

`/preset` opens a **three-level preset manager** in the TUI — pure TUI, like
the built-in `/models`, so it triggers no LLM turn.

| Level | What you do |
|-------|-------------|
| 1. Preset list | Apply / Edit / Delete an existing preset, or create a new one |
| 2. Agent arrangement | Select a base preset, add / remove / edit local overrides, then Save (or Save & Apply) |
| 3. Edit agent | Pick model → variant (thinking strength) → temperature → options (JSON) |

> Invoke the manager via autocomplete selection or a keybind. On OpenCode v1,
> `/preset` is TUI-only (like `/models`). On capable OpenCode v2 hosts, the
> server command `/preset <name>` instead binds the selected team to the
> current session's future child sessions; see below.

## How It Works

1. Define named presets in `mechanicus.jsonc` under the `presets`
   field, or create them interactively from the manager
2. The manager writes preset changes to the user config file
3. **Apply** persists the preset name to the config file only — the
   sidebar is NOT refreshed mid-session (the agent registry is unchanged
   until reload; showing new models against running agents would be
   misleading)
4. **Reload OpenCode** (or start a new conversation) for the new preset to
   take effect on the agent registry
5. The current session is **not** reloaded — this is deliberate.
   Hot-swapping the agent tree mid-conversation could truncate context (a
   new model may have a smaller window), drift prior assistant turns under
   a changed system prompt, leave running subagents referencing stale agent
   definitions, or shift tool/skill availability. A future path to true
   in-session switching without reset requires a host API for atomic
   agent-registry refresh with session compatibility checks.

### Level 3 — model and variant selection

The model picker lists every model from all connected providers (fetched from
the server's provider registry). If the chosen model exposes variants (e.g.
`thinking`, `high`, `low`), a variant picker follows — this is the "thinking
strength" selector. Temperature is a numeric prompt (0–2 or blank). Options is
a raw JSON prompt for provider-specific settings (e.g.
`{"thinking":{"type":"enabled","budgetTokens":10000}}`).

## Example Configuration

```jsonc
{
  "presets": {
    "cheap": {
      "orchestrator": { "model": "anthropic/claude-3.5-haiku" },
      "explorer": { "model": "openai/gpt-5.6-luna" },
      "oracle": { "model": "anthropic/claude-sonnet-4-6" }
    },
    "powerful": {
      "orchestrator": { "model": "openai/gpt-5.6" },
      "oracle": { "model": "anthropic/claude-opus-4-6" },
      "librarian": { "model": "anthropic/claude-sonnet-4-6" }
    },
    "thinking": {
      "oracle": {
        "model": "anthropic/claude-sonnet-4-6",
        "variant": "thinking",
        "options": { "thinking": { "type": "enabled", "budgetTokens": 10000 } }
      }
    }
  }
}
```

## Supported Fields

### Reuse a Base Preset

Use `extends` and `agents` to keep shared model settings in a parent preset:

```jsonc
{
  "preset": "cheap-thinking",
  "presets": {
    "cheap": {
      "orchestrator": { "model": "openai/gpt-5.6-luna" }
    },
    "cheap-thinking": {
      "extends": "cheap",
      "agents": {
        "orchestrator": { "variant": "high" }
      }
    }
  }
}
```

Parent fields apply first, child fields override them, and root-level `agents`
have the highest precedence. User and project config layers merge before the
chain is resolved. Missing parents and cycles produce a warning and do not
apply a partial preset. Switching to an invalid preset writes nothing.

The v1 manager shows a **Base preset** row and inherited agents as read-only
rows. Add a local override to customize an inherited agent, or edit its parent.
Saving writes only the parent reference and local overrides, so shared parent
settings stay in the parent. The base picker excludes choices that would create
an inheritance cycle. Deleting a parent fails with the dependent preset names;
change their base references first.

The editor changes only user-level declarations. Project overrides stay in
`.opencode/mechanicus.json[c]` and are never copied into the user file. Edit a
project-only preset directly in that file. JSONC comments, unrelated fields,
BOM, line endings and config symlinks survive preset writes. If the edited
preset changes on disk while the editor is open, saving fails and preserves the
newer contents; reopen the preset before retrying. Invalid JSONC or duplicate
keys also prevent writing.

Global Apply reports an error when `MECHANICUS_PRESET` or a project `preset`
would mask the selection after reload. The v2 TUI continues to offer its global
selection picker. See [Configuration](configuration.md#preset-inheritance)
for merge rules and inline syntax.

The following fields are applied when the preset is loaded on restart:

| Field | Description |
|-------|-------------|
| `model` | Model ID in `provider/model` format. Array form (fallback chains) is resolved to the first entry |
| `temperature` | Inference temperature (0-2) |
| `variant` | Model variant (e.g. `"thinking"`) |
| `options` | Provider-specific options (e.g. thinking budget) |

Fields not applied at runtime (require restart): `prompt`, `skills`, `mcps`, `displayName`.

## Startup Preset vs Runtime Switching

There are two ways to activate a preset:

| Method | How | Persists? |
|--------|-----|-----------|
| Config file | Set `"preset": "cheap"` in `mechanicus.jsonc` | Yes, across restarts |
| `/preset` TUI command | Select a preset from the picker during a session | Yes — writes to config file |

The `/preset` TUI command writes the selected preset name to the config file,
so the switch persists across restarts. **Reload OpenCode** for the new preset
to take effect on the agent registry. The current session continues
uninterrupted with its existing models.

### OpenCode v2 session binding

On v2 hosts with session identity, model-switch and KV storage APIs, the
server `/preset <name>` command stores a session-scoped inference snapshot.
It does not write the config file or replace the agent registry:

- the root model, prompts, tools, skills, MCP configuration and existing
  children stay unchanged;
- new native `subagent` children receive the selected model, variant,
  temperature and provider options before their first request;
- each child keeps its launch snapshot and fallback chain after restart or a
  later parent rebind; an explicit per-call model wins over the preset;
- `/preset` without a name lists presets and distinguishes the current
  session team from the global default.

Host command execution has no display-only response channel here, so feedback
is returned through the command error channel without creating a user message
or provider turn. If storage, identity or the child-creation barrier is
unavailable, managed launches fail closed instead of silently using another
preset. Historical children without a launch snapshot retain their model.

The v2 TUI's global picker retains the disk-persistence/reload behavior above.
The existing Companion supports session navigation and has no preset-selection
or session-binding protocol. It never claims that changing a global config
binds an active v2 session.

> See [Configuration](configuration.md) for the full preset option reference.

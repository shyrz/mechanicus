# mechanicus companion (Tauri, experimental)

A second implementation of the desktop companion, built on Tauri v2, used to
evaluate whether replacing the Rust + egui companion is worth it.

It is a **drop-in consumer of the existing plugin contract**: it only *reads*
`companion-state.json` and never writes it, so it can run alongside the original
companion. Switch between them with `companion.binaryPath`.

## Why a separate implementation

The plugin ↔ companion boundary was already clean:

| Contract | Value |
| --- | --- |
| State file (read) | `~/.local/share/opencode/storage/mechanicus/companion-state.json` |
| Command file (write) | `~/.local/share/opencode/storage/mechanicus/companion-command.json` |
| Env | `MECHANICUS_COMPANION_SESSION_ID`, `MECHANICUS_COMPANION_DEBUG` |
| Pid files | `companion.pid`, `companion.<sessionId>.pid` |

`companion-state.json` is read-only from here; the command file is this
process's only write, and it carries clicks rather than state.

Nothing in `src/companion/manager.ts` needs to change to run this binary, which
is what makes the replacement safe to trial and easy to roll back.

## Layout

```
companion-tauri/
├── src-tauri/          # Rust host: window config, state polling, commands
│   ├── src/main.rs     # setup, poll loop, payload shaping, commands
│   ├── src/snap.rs     # snap targets, envelope geometry, drag settling
│   ├── src/workarea.rs # display/work-area measurement (AppKit)
│   ├── src/pointer.rs  # physical mouse-button state (AppKit)
│   ├── src/hit_test.rs # click-through regions
│   ├── src/state.rs    # companion-state.json contract + session selection
│   ├── src/command.rs  # companion → plugin navigation requests
│   ├── src/singleton.rs
│   ├── tauri.conf.json
│   └── capabilities/   # Tauri v2 permissions for the frontend
├── ui/                 # Static frontend (no build step)
│   ├── main.js         # port of gifs.rs frame math + drag/click handling
│   └── overlay.js      # dim layer + landing markers
└── scripts/sync-assets.sh
```

## Running it

```bash
# 1. Copy the sprite sheets the webview loads.
./scripts/sync-assets.sh

# 2. Build and run. The session id is required — without it the process exits,
#    exactly like the original companion.
cd src-tauri
MECHANICUS_COMPANION_SESSION_ID=dev cargo run
```

`dev` is not a real session id; the selector falls back to the normal
heuristics, so a running OpenCode session is displayed anyway.

### Mounting it into the plugin

```jsonc
// ~/.config/opencode/mechanicus.json
{
  "companion": {
    "enabled": true,
    "binaryPath": "/absolute/path/to/companion-tauri/src-tauri/target/debug/mechanicus-companion-tauri"
  }
}
```

Custom `binaryPath` values are skipped by the plugin's auto-updater, so this
binary is never overwritten. Kill the running companion and restart OpenCode for
it to take effect.

## What is implemented

- Frameless, transparent, always-on-top, excluded from the Dock (`Accessory`
  activation policy), never steals focus
- Reads the plugin state file on the same 250 ms cadence as the original
- Session selection ported from the original so both pick the same session
- Sprite-sheet animation: `frameIndex` / `frameCell` are direct ports of
  `gifs.rs`, so the same sheet shows the same frame at the same instant
- Agent → sheet mapping including `councillor-*` → council, `intro`, `input`,
  `unknown` fallback
- Native window drag with a click/drag threshold
- Per-project window position restore
- Click to open the session being shown, through a file-based channel to the
  plugin (see [Clicking the overlay](#clicking-the-overlay))

## Snapping

While the overlay is dragged, the whole screen dims and three white markers show
where it can land: **left middle**, **right middle**, and **bottom centre, above
the Dock**. Releasing near one docks it there with the outer edge sitting flush
against the screen edge.

- The window is moved and resized **once** to a snap *envelope* — the bounding
  box of both the expanded overlay and the collapsed handle. Only the content
  inside it animates afterwards, because resizing a native window every frame is
  janky on macOS.
- The envelope is also the full set of positions the handle could occupy, so
  both states sit flush against the edge and the overlay only ever travels
  *along* it while animating.
- Docked, it collapses to a slim handle (22 px thick) hugging the edge, with
  rounded inner corners, a grip line, and a status colour.
- Hovering the handle expands it back to the animated overlay; moving away
  re-collapses it (90 ms open delay, 420 ms close delay). Opening animates in
  about 80 ms, closing in about 176 ms: opening answers the cursor directly, so
  it is quicker, while closing is a passive retreat and reads better unhurried.
  The delays and the two speeds are constants in `snap.rs`; 16 ms ticks quantise
  the durations, so they land on tick boundaries rather than the ideal
  `1 / speed`.
- The click-through region follows the *visible content*, never the envelope, so
  the transparent remainder of the window never swallows clicks.

Targets are derived from the work area, so a taller Dock moves the bottom target
up with it rather than letting the handle overlap the Dock. The catch radius
defaults to 160 px and is tunable with `MECHANICUS_COMPANION_TAURI_SNAP_PX`;
releasing further than that from every target leaves the overlay where the drag
ended.

The markers preview the handle's exact footprint and are placed from the same
geometry the drop uses, so what is shown and where it lands cannot drift apart.

### The dim overlay

The dim is a second, full-screen window created at startup and only shown while
a drag is in flight. It is sized once at creation rather than on each drag
start, because resizing it would add main-thread work to the exact frame the
drag begins on, which is when the frame budget is tightest. It renders the three
markers and is click-through, so the drag continues underneath it.

It polls its state every ~33 ms rather than receiving pushed events: the main
thread is inside the native drag loop for the duration, so a queued event would
only be delivered after the drop, when the overlay is already gone.

### Detecting the end of a drag

A compositor drag cannot report its own end. `startDragging` only posts a request
to the main thread and returns immediately, and the nested drag loop that follows
swallows the mouse events, so the webview never sees a `pointerup` either.

Watching the window position is not enough to stand in for a release: the
position also stops changing whenever the user pauses mid-drag, so treating that
as the end would settle the snap and clear the overlay while the button is still
down. The loop therefore reads the physical mouse button
(`NSEvent.pressedMouseButtons`), which is a state query rather than an event tap
and so needs no Accessibility permission. Only when the button is up does the
position decide where the snap lands. Platforms that cannot answer fall back to
the position heuristic alone.

## Clicking the overlay

A primary click that is not a drag asks the OpenCode TUI to open the session the
overlay is showing. The companion is a detached process with no channel to the
plugin, so the click becomes a file and the plugin polls for it.

```
Click → navigate_to_session → companion-command.json → TUI claims it → routes to the session
```

- `src-tauri/src/command.rs` writes the request atomically (temp file + rename),
  so a polling reader never sees a half-written file.
- Each TUI window polls every 250 ms. The file usually does not exist, so the
  check is close to free.
- Claiming is an atomic rename, which makes a request single-use: with several
  windows polling, exactly one wins and the rest see it gone.
- The window showing the requesting project takes it. Another project waits out
  a 400 ms grace period, after which any window may take it, because landing in
  the right project still beats a click that silently does nothing.
- A request expires after 3 s, so a click is never answered much later by a
  window that happened to start afterwards. With no TUI window running, the
  request simply expires and nothing happens.

This channel never writes `companion-state.json`. That file belongs to the
plugin, and the companion's read-only contract with it is what lets both
implementations run side by side.

## Test hooks

Driving a real drag, a real cursor or a real click from a script needs
Accessibility permission for synthetic events, which otherwise makes the snap
and navigation pipelines untestable. `MECHANICUS_COMPANION_TAURI_TEST_HOOKS=1`
enables file-driven stand-ins that run through the same code paths:

| File (beside `companion-state.json`) | Content | Effect |
| --- | --- | --- |
| `companion-tauri-test-drop` | `x,y` in logical px | Emulates "dragged and released here": moves the window, then lets the settle watcher evaluate the snap |
| `companion-tauri-test-drop` | `hold x,y` | Emulates a drag still in flight: the settle watcher is suppressed so the dim overlay and its markers can be observed |
| `companion-tauri-test-drop` | `release` | Ends a `hold`, handing back to the normal settle path |
| `companion-tauri-test-drop` | `click` | Emulates a click on the overlay, requesting navigation to the session it is showing |
| `companion-tauri-test-drop` | `click <sessionId>` | Same, but targeting a specific session so the request is assertable |
| `companion-tauri-test-cursor` | `x,y` in logical px | Overrides the polled global cursor, for hover/expand testing |

Files are consumed once. The hooks only *nudge*: the drop hook moves the window
and leaves the snap decision to the production settle watcher, and the click
hook writes a real request onto the real channel, so both exercise the shipping
behaviour rather than a shortcut.

Coordinates are logical (points). On a 2x display, mixing logical and physical
pixels silently places the cursor off-window.

## Debug keys

These exist to make the snap and pass-through behaviour testable by hand and are
expected to be removed or moved behind a config flag:

| Key | Effect |
| --- | --- |
| `s` | Toggle edge snapping |
| `t` | Force window-level mouse pass-through |

## Deliberately not implemented yet

These are the parts of the plan that are framework-independent, so they are not
blocked on this spike:

- **Attention states.** The plugin only publishes `idle` / `busy` /
  `waiting-input`. Rich permission/question state needs the plugin to read
  `session.permission(sessionID)` / `session.question(sessionID)` and write it
  into the state file. The overlay already renders a status ring ready for it.
- **Runtime assets.** Sheets are copied at build time. Loading them from a user
  directory with a bundled fallback is the change that makes swapping art a
  file-copy instead of a rebuild.

## Packaging notes

The macOS `.app` is a directory, not a file. The plugin currently assumes a
single executable:

- `resolveCompanionBinaryPath` uses `existsSync`, which returns true for a
  directory, so spawning a `.app` directly fails at exec time.
- `installCompanionArchive` extracts one file, `chmod`s it and renames it into
  place — that does not transfer to a bundle.

Both need a bundle-aware branch before this can be distributed. `binaryPath`
sidesteps them entirely for evaluation: point it at
`Companion.app/Contents/MacOS/<binary>` so PID tracking keeps working.

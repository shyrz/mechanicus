#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Experimental Tauri implementation of the mechanicus desktop companion.
//!
//! It is deliberately a *drop-in consumer* of the existing plugin contract: it
//! only reads `companion-state.json` and never writes it, so both this and the
//! original Rust companion can run side by side. Point
//! `companion.binaryPath` at this binary to try it.

mod activate;
mod command;
mod hit_test;
mod pointer;
mod singleton;
mod snap;
mod state;
mod workarea;

use std::sync::Arc;
use std::time::Duration;
use tauri::{Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder};

/// Same cadence as the original companion's state watcher.
const POLL_INTERVAL: Duration = Duration::from_millis(250);
const EVENT_NAME: &str = "companion://state";
/// Snap state stream (collapse/expand progress and content rect).
const SNAP_EVENT: &str = "companion://snap";
/// Full-screen dim + landing markers, shown only while dragging.
const OVERLAY_LABEL: &str = "snap-overlay";
/// Distance from the screen edge, matching the original companion's `GAP`.
const GAP: f32 = 10.0;

#[derive(Clone, PartialEq, serde::Serialize)]
struct SessionPayload {
    session_id: String,
    cwd: String,
    project: String,
    status: String,
    agents: Vec<String>,
}

#[derive(Clone, PartialEq, serde::Serialize)]
struct ConfigPayload {
    position: String,
    size: String,
    speed: f32,
    loop_style: String,
}

impl Default for ConfigPayload {
    fn default() -> Self {
        Self {
            position: "bottom-right".to_string(),
            size: "medium".to_string(),
            speed: 1.0,
            loop_style: "classic".to_string(),
        }
    }
}

#[derive(Clone, PartialEq, serde::Serialize)]
struct Payload {
    session: Option<SessionPayload>,
    config: ConfigPayload,
    cell: f32,
    cols: usize,
    rows: usize,
}

/// Grid shape for `n` agents, matching the original companion's layout.
fn grid_dims(n: usize) -> (usize, usize) {
    let n = n.max(1);
    let cols = match n {
        0 | 1 => 1,
        2..=4 => 2,
        _ => 3,
    };
    let rows = n.div_ceil(cols);
    (cols, rows)
}

fn cell_size(size: &str) -> f32 {
    match size {
        "small" => 80.0,
        "large" => 160.0,
        "xl" | "xlarge" => 200.0,
        _ => 120.0,
    }
}

fn build_payload(st: &state::CompanionState, owner: Option<&str>) -> Payload {
    let config = st
        .config
        .as_ref()
        .map(|c| ConfigPayload {
            position: c.position.clone(),
            size: c.size.clone(),
            speed: c.speed,
            loop_style: c.loop_style.clone(),
        })
        .unwrap_or_default();

    let session = state::choose_session(&st.sessions, owner).map(|idx| {
        let s = &st.sessions[idx];
        SessionPayload {
            session_id: s.session_id.clone(),
            cwd: s.cwd.clone(),
            project: std::path::Path::new(&s.cwd)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("unknown")
                .to_string(),
            status: s.status.clone(),
            agents: if s.active_agents.is_empty() {
                vec!["intro".to_string()]
            } else {
                s.active_agents.clone()
            },
        }
    });

    let agent_count = session.as_ref().map(|s| s.agents.len().max(1)).unwrap_or(1);
    let (cols, rows) = grid_dims(agent_count);
    let cell = cell_size(&config.size);

    Payload {
        session,
        config,
        cell,
        cols,
        rows,
    }
}

/// Applies window geometry: size from the grid, position from the saved
/// per-project position when available, otherwise the configured anchor.
fn apply_geometry(window: &tauri::WebviewWindow, payload: &Payload, saved: Option<(f32, f32)>) {
    let width = payload.cell * payload.cols as f32;
    let height = payload.cell * payload.rows as f32;

    let _ = window.set_size(LogicalSize::new(width, height));

    let (screen_w, screen_h) = window
        .current_monitor()
        .ok()
        .flatten()
        .map(|m| {
            let logical = m.size().to_logical::<f32>(m.scale_factor());
            (logical.width, logical.height)
        })
        .unwrap_or((1440.0, 900.0));

    let (x, y) = match saved {
        Some((sx, sy)) => (sx, sy),
        None => {
            let x_max = (screen_w - width - GAP).max(GAP);
            let y_max = (screen_h - height - GAP).max(GAP);
            match payload.config.position.as_str() {
                "bottom-left" => (GAP, y_max),
                "top-right" => (x_max, GAP),
                "top-left" => (GAP, GAP),
                _ => (x_max, y_max),
            }
        }
    };

    let _ = window.set_position(LogicalPosition::new(x, y));
}

fn poll_loop(handle: tauri::AppHandle, owner: Option<String>, snap: Arc<snap::SnapController>) {
    let path = state::state_file_path();
    let mut last: Option<Payload> = None;
    let mut positioned = false;

    loop {
        let st = state::read_state(&path);
        let payload = build_payload(&st, owner.as_deref());

        let target = (
            payload.cell * payload.cols as f32,
            payload.cell * payload.rows as f32,
        );
        snap.set_content_size(target.0 as f64, target.1 as f64);

        if let Some(window) = handle.get_webview_window("main") {
            if !positioned {
                // Resolve the saved position once, before the frontend starts
                // dragging the window around.
                let saved = st
                    .window_positions
                    .iter()
                    .find(|(key, _)| {
                        std::path::Path::new(key.as_str())
                            .file_name()
                            .and_then(|n| n.to_str())
                            == std::path::Path::new(
                                payload
                                    .session
                                    .as_ref()
                                    .map(|s| s.cwd.as_str())
                                    .unwrap_or(""),
                            )
                            .file_name()
                            .and_then(|n| n.to_str())
                    })
                    .map(|(_, pos)| (pos.x, pos.y));

                apply_geometry(&window, &payload, saved);
                positioned = true;
            } else if last.as_ref() != Some(&payload) && !snap.is_snapped() && !snap.is_dragging() {
                // Skip while snapped (the window is pinned to its envelope and
                // only the content inside changes size) and while dragging (the
                // compositor owns the geometry; resizing mid-drag would fight
                // it). A size change is picked up on the next idle poll.
                let _ = window.set_size(LogicalSize::new(target.0, target.1));
            }

            poll_test_hook(&window, &snap);
        }

        if last.as_ref() != Some(&payload) {
            let _ = handle.emit(EVENT_NAME, &payload);
            last = Some(payload);
        }

        std::thread::sleep(POLL_INTERVAL);
    }
}

/// Initial state for the first paint, so the window is never blank.
#[tauri::command]
fn get_state() -> Payload {
    let owner = std::env::var("MECHANICUS_COMPANION_SESSION_ID").ok();
    let st = state::read_state(&state::state_file_path());
    build_payload(&st, owner.as_deref())
}

/// Handles a click on the overlay, revealing the session it is showing as far
/// as the host allows.
#[tauri::command]
fn reveal_session(session_id: String, cwd: String) -> Result<(), String> {
    reveal(&session_id, &cwd)
}

/// The click's policy, shared by the command and the test hook so a scripted
/// click exercises the same decisions a real one does.
///
/// A TUI owns a router, so the click becomes a request file that whichever
/// window is showing this project picks up. A desktop host cannot focus a
/// session at all, so there the click raises the app with the session URL.
/// Best-effort in both cases: a click nothing answers leaves the overlay as it
/// was.
fn reveal(session_id: &str, cwd: &str) -> Result<(), String> {
    match host_capability() {
        Some(host) => {
            // No session router here, so raising the app is the whole gesture.
            if activate::reveal_host(session_id, host.bundle_id.as_deref()) {
                Ok(())
            } else {
                Err(format!("could not raise the {:?} host", host.kind))
            }
        }
        None => command::request_navigation(session_id, cwd).map_err(|e| e.to_string()),
    }
}

/// The host's click capability, as last published by the plugin.
fn host_capability() -> Option<state::HostInfo> {
    state::read_state(&state::state_file_path()).host
}

/// Toggles window-level mouse pass-through. Used while validating whether a
/// circular overlay can keep its corners click-through.
#[tauri::command]
fn set_click_through(window: tauri::WebviewWindow, ignore: bool) -> Result<(), String> {
    window
        .set_ignore_cursor_events(ignore)
        .map_err(|e| e.to_string())
}

/// Enables or disables edge snapping at runtime.
#[tauri::command]
fn set_snap_enabled(controller: tauri::State<'_, Arc<snap::SnapController>>, enabled: bool) {
    controller.set_enabled(enabled);
}

/// Test hook: emulates "the user dragged the overlay and let go at this
/// position", so the snap pipeline can be verified without a human and without
/// Accessibility permission for synthetic mouse events.
///
/// It deliberately goes through the same path as a real drag: the window is
/// moved, then the settle watcher notices the motion has stopped and evaluates
/// the snap. Only active when `MECHANICUS_COMPANION_TAURI_TEST_HOOKS=1`.
#[tauri::command]
fn simulate_drop(
    window: tauri::WebviewWindow,
    controller: tauri::State<'_, Arc<snap::SnapController>>,
    x: f64,
    y: f64,
) -> Result<(), String> {
    if !test_hooks_enabled() {
        return Err("test hooks disabled; set MECHANICUS_COMPANION_TAURI_TEST_HOOKS=1".to_string());
    }
    controller.begin_drag();
    window
        .set_position(LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    // Stand in for the pointer release so the settle window is short.
    controller.hint_drag_end();
    Ok(())
}

/// Cursor source for the snap loop: the real global cursor, or a scripted
/// override while test hooks are enabled.
pub enum CursorSource {
    Real,
    /// A fixed point in *screen* coordinates (top-left origin), read from
    /// [`test_cursor_file`].
    Override(std::path::PathBuf),
}

impl CursorSource {
    /// Resolves the cursor position in *physical* screen coordinates, matching
    /// what `Window::cursor_position()` returns.
    ///
    /// The override reads *logical* coordinates because that is the space
    /// window positions and screen bounds are expressed in, and it is what a
    /// human writing a test command expects; the conversion happens here so the
    /// loop sees exactly what a real cursor would produce on a 2x display.
    pub fn position(&self, window: &tauri::WebviewWindow) -> Option<(f64, f64)> {
        match self {
            CursorSource::Real => window.cursor_position().ok().map(|p| (p.x, p.y)),
            CursorSource::Override(path) => {
                // Fall back to the real cursor when no override is pending.
                // Returning None here would stall the whole snap loop, which
                // also owns click-through and the drag-settle detection.
                let Ok(raw) = std::fs::read_to_string(path) else {
                    return window.cursor_position().ok().map(|p| (p.x, p.y));
                };
                let mut parts = raw.trim().split(',');
                let x = parts.next()?.trim().parse::<f64>().ok()?;
                let y = parts.next()?.trim().parse::<f64>().ok()?;
                if !x.is_finite() || !y.is_finite() {
                    return None;
                }
                let scale = window.scale_factor().ok()?;
                Some((x * scale, y * scale))
            }
        }
    }
}

/// Resolves the cursor source once, honoring the test-hook override.
pub fn cursor_source() -> CursorSource {
    if test_hooks_enabled() {
        CursorSource::Override(test_cursor_file())
    } else {
        CursorSource::Real
    }
}

fn test_hooks_enabled() -> bool {
    std::env::var("MECHANICUS_COMPANION_TAURI_TEST_HOOKS").as_deref() == Ok("1")
}

/// Path polled for drag commands while test hooks are enabled.
fn test_drop_file() -> std::path::PathBuf {
    state::state_file_path().with_file_name("companion-tauri-test-drop")
}

/// Path polled for a fake cursor position while test hooks are enabled.
///
/// Hover detection polls the *global* cursor, which cannot be driven from a
/// script without Accessibility permission for synthetic events. Overriding the
/// polled value exercises the same hover/expand state machine in the loop.
fn test_cursor_file() -> std::path::PathBuf {
    state::state_file_path().with_file_name("companion-tauri-test-cursor")
}

/// Runs a queued drag command written to [`test_drop_file`].
///
/// Command forms:
///
/// - `x,y` — emulate "dragged here and released": moves the window and lets the
///   settle watcher evaluate the snap.
/// - `hold x,y` — emulate an in-flight drag that never ends on its own, so the
///   dim overlay and its markers can be observed.
/// - `release` — end a drag opened by `hold`.
/// - `click` / `click <sessionId>` — emulate a click on the overlay, which
///   asks the plugin to open a session.
///
/// The file is removed once consumed so each write triggers exactly one command.
/// This exists because Tauri's IPC is only reachable from inside the webview,
/// which leaves the snap pipeline untestable from a script otherwise.
fn poll_test_hook(window: &tauri::WebviewWindow, controller: &Arc<snap::SnapController>) {
    if !test_hooks_enabled() {
        return;
    }
    let path = test_drop_file();
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return;
    };
    let _ = std::fs::remove_file(&path);

    let raw = raw.trim().to_string();
    if raw == "release" {
        eprintln!("[test-hook] release");
        controller.release_drag();
        return;
    }
    if let Some(rest) = raw.strip_prefix("click") {
        // Stands in for a click on the overlay, which cannot be synthesised
        // without Accessibility permission. `click` uses the session the
        // overlay is showing; `click <sessionId>` targets a specific one, which
        // is what makes the request assertable from a script.
        let st = state::read_state(&state::state_file_path());
        let owner = std::env::var("MECHANICUS_COMPANION_SESSION_ID").ok();
        let showing = state::choose_session(&st.sessions, owner.as_deref())
            .map(|idx| st.sessions[idx].clone());

        let target = if rest.trim().is_empty() {
            showing.map(|s| (s.session_id, s.cwd))
        } else {
            let session_id = rest.trim().to_string();
            st.sessions
                .iter()
                .find(|s| s.session_id == session_id)
                .map(|s| (s.session_id.clone(), s.cwd.clone()))
                .or_else(|| Some((session_id, String::new())))
        };

        match target {
            Some((session_id, cwd)) => match reveal(&session_id, &cwd) {
                Ok(()) => eprintln!("[test-hook] click -> {session_id} ({cwd})"),
                Err(err) => eprintln!("[test-hook] click failed: {err}"),
            },
            None => eprintln!("[test-hook] click: no session to target"),
        }
        return;
    }

    let (hold, coords) = match raw.strip_prefix("hold") {
        Some(rest) => (true, rest.trim().to_string()),
        None => (false, raw.clone()),
    };

    let mut parts = coords.split(',');
    let (Some(x), Some(y)) = (parts.next(), parts.next()) else {
        eprintln!("[test-hook] expected 'x,y', 'hold x,y' or 'release', got {raw:?}");
        return;
    };
    let (Ok(x), Ok(y)) = (x.trim().parse::<f64>(), y.trim().parse::<f64>()) else {
        eprintln!("[test-hook] unparsable coordinates in {raw:?}");
        return;
    };

    if let Some(s) = controller.screen() {
        let probe = workarea::Rect {
            x,
            y,
            w: 160.0,
            h: 80.0,
        };
        let picked = snap::resolve_drop(probe, s.work, (160.0, 80.0));
        let (near, dist) = snap::nearest_target(probe, s.work, (160.0, 80.0));
        eprintln!(
            "[test-hook] {}({x}, {y}) nearest={near:?} dist={dist:.1} picked={picked:?}",
            if hold { "holding at " } else { "drop at " },
        );
    } else {
        eprintln!("[test-hook] screen geometry unavailable");
    }

    // Re-measure the work area exactly as a real drag start does, so the hook
    // exercises the production entry path rather than a shortcut.
    refresh_screen(window.app_handle().clone(), controller, None);

    if hold {
        controller.begin_held_drag();
    } else {
        controller.begin_drag();
    }
    let _ = window.set_position(LogicalPosition::new(x, y));
    if !hold {
        controller.hint_drag_end();
    }
}

/// Reports that the user began dragging the overlay, or that the pointer is up.
///
/// Only the start is authoritative. `performWindowDragWithEvent` returns before
/// the drag is over, so the snap loop detects the end by watching the window
/// position settle — which also means the snap is evaluated at the position the
/// drag actually finished at.
#[tauri::command]
fn set_dragging(
    app: tauri::AppHandle,
    controller: tauri::State<'_, Arc<snap::SnapController>>,
    dragging: bool,
) {
    if dragging {
        // Measure the work area before the drag can block the main thread, so
        // the "above the Dock" target is right even if the Dock just moved.
        refresh_screen(app.clone(), &controller, None);
        controller.begin_drag();
    } else {
        controller.hint_drag_end();
    }
}

/// Re-measures the screen containing `anchor` (or the cursor) on the main
/// thread, then stores it for the snap loop.
///
/// AppKit must be touched from the main thread, and the snap loop deliberately
/// runs off it, so the geometry is measured here and handed over as plain data.
fn refresh_screen(
    app: tauri::AppHandle,
    controller: &Arc<snap::SnapController>,
    anchor: Option<(f64, f64)>,
) {
    use std::sync::mpsc;

    let (tx, rx) = mpsc::channel();
    let probe = anchor.unwrap_or((0.0, 0.0));
    let dispatched = app.run_on_main_thread(move || {
        let _ = tx.send(workarea::screen_at(probe));
    });
    if dispatched.is_err() {
        return;
    }
    // The main thread is free at this point: this runs before the drag starts.
    if let Ok(Some(info)) = rx.recv_timeout(Duration::from_millis(400)) {
        controller.set_screen(info);
    }
}

/// Snapshot the dim overlay polls each frame while a drag is in flight.
#[tauri::command]
fn snap_overlay_state(
    controller: tauri::State<'_, Arc<snap::SnapController>>,
) -> snap::OverlayState {
    controller.overlay_state()
}

fn main() {
    let Some(owner_session_id) = std::env::var("MECHANICUS_COMPANION_SESSION_ID")
        .ok()
        .filter(|id| !id.trim().is_empty())
    else {
        eprintln!("[companion-tauri] missing MECHANICUS_COMPANION_SESSION_ID; exiting");
        return;
    };

    if !singleton::acquire(&owner_session_id) {
        eprintln!("[companion-tauri] another instance owns {owner_session_id}; exiting");
        return;
    }

    let snap_controller = snap::SnapController::new();

    tauri::Builder::default()
        .manage(Arc::clone(&snap_controller))
        .invoke_handler(tauri::generate_handler![
            get_state,
            reveal_session,
            set_click_through,
            set_snap_enabled,
            set_dragging,
            snap_overlay_state,
            simulate_drop
        ])
        .setup(move |app| {
            // Match the original companion: a macOS accessory app, so no Dock
            // icon and the terminal keeps focus when the overlay appears.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // Measured on the main thread, which `setup` already runs on.
            if let Some(info) = workarea::screen_at((0.0, 0.0)) {
                snap_controller.set_screen(info);
            }

            // The dim overlay is created once and only shown while dragging:
            // creating a window mid-drag would have to wait for the main thread
            // to leave the drag loop.
            if let Err(err) = build_overlay_window(app) {
                eprintln!("[companion-tauri] snap overlay unavailable: {err}");
            }

            if let Some(window) = app.get_webview_window("main") {
                let emitter = window.clone();
                let overlay = app.get_webview_window(OVERLAY_LABEL);
                let controller = Arc::clone(&snap_controller);
                snap::spawn(
                    window,
                    controller,
                    cursor_source(),
                    move |payload| {
                        let _ = emitter.emit(SNAP_EVENT, payload);
                    },
                    move |dragging| set_overlay_visible(&overlay, dragging),
                );
            }

            let handle = app.handle().clone();
            let owner = Some(owner_session_id.clone());
            let controller = Arc::clone(&snap_controller);
            std::thread::spawn(move || poll_loop(handle, owner, controller));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running companion");
}

/// Creates the hidden full-screen dim overlay.
///
/// Sized once here to cover the display. Resizing it on every drag start would
/// add main-thread work to the exact frame the drag begins on, which is when the
/// frame budget is tightest.
fn build_overlay_window(app: &tauri::App) -> tauri::Result<()> {
    let mut builder =
        WebviewWindowBuilder::new(app, OVERLAY_LABEL, WebviewUrl::App("overlay.html".into()))
            .title("snap targets")
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .shadow(false)
            .focused(false)
            .focusable(false)
            .resizable(false)
            .visible(false);

    if let Some(info) = workarea::screen_at((0.0, 0.0)) {
        builder = builder
            .position(info.frame.x, info.frame.y)
            .inner_size(info.frame.w, info.frame.h);
    }

    let window = builder.build()?;

    // Purely an indicator: never intercept the drag it is describing.
    let _ = window.set_ignore_cursor_events(true);
    Ok(())
}

/// Shows or hides the dim overlay.
///
/// Deliberately non-blocking: this runs inside the 16 ms snap loop, so it must
/// not wait on the main thread. The overlay is created already covering the
/// display, so showing it is a plain visibility toggle. Tauri's window methods
/// dispatch to the main thread themselves, which makes calling them from this
/// thread safe.
fn set_overlay_visible(overlay: &Option<tauri::WebviewWindow>, visible: bool) {
    let Some(overlay) = overlay else {
        return;
    };
    if visible {
        let _ = overlay.show();
    } else {
        let _ = overlay.hide();
    }
}

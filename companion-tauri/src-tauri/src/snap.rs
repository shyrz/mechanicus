//! Snap targets and the collapse/expand animation.
//!
//! The overlay docks to exactly three places: the middle of the left edge, the
//! middle of the right edge, and the centre of the bottom edge above the Dock.
//! While a drag is in flight the whole screen dims and the three landing spots
//! are marked with pills, so the destination is visible before releasing.
//!
//! Two choices keep the motion smooth:
//!
//! 1. **The OS window never resizes while docked.** It is sized once to an
//!    *envelope* holding both the expanded and collapsed footprints, and only
//!    the content inside animates. Resizing a native window every frame is
//!    janky on macOS; moving content inside a fixed window is not.
//! 2. **The hit region follows the content, not the window.** The rest of the
//!    envelope is transparent and click-through, so it cannot swallow clicks
//!    meant for whatever is behind it.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{LogicalPosition, LogicalSize, WebviewWindow};

use crate::pointer;
use crate::workarea::{Rect, ScreenInfo};

/// Thickness of the collapsed handle, perpendicular to the docked edge. Mirrored by
/// `.handle-grip`'s width in `ui/style.css` -- the pill is drawn there, this only
/// sizes the box it is centred in -- and pinned by
/// `src/companion/handle-geometry.test.ts` so the two cannot drift apart.
pub const HANDLE_THICK: f64 = 16.0;
/// Length of the collapsed handle, along the docked edge.
pub const HANDLE_LONG: f64 = 84.0;
/// How close a drop must land to a target for it to dock there. Beyond this the
/// overlay stays where it was dropped, unsnapped.
pub const SNAP_RADIUS_DEFAULT: f64 = 160.0;
/// Size of the pill markers, which preview the collapsed handle footprint.
const PILL_PAD: f64 = 5.0;
/// Gap the pill markers keep from the work-area edge.
///
/// The handle they preview is flush with the edge, so padding it outward would put
/// that padding past the edge — and the overlay window ends exactly there, so the
/// capsule would be clipped and lose its rounded end. The marker is held inside by
/// this gap instead. It costs a few pixels of positional accuracy at the edges and
/// buys a shape that reads as a capsule rather than a cut-off bar.
const PILL_MARGIN: f64 = 4.0;
/// Delay before expanding after the cursor reaches the handle.
const HOVER_OPEN_DELAY: Duration = Duration::from_millis(90);
/// Delay before collapsing after the cursor leaves the expanded overlay.
const HOVER_CLOSE_DELAY: Duration = Duration::from_millis(420);
const TICK: Duration = Duration::from_millis(16);
/// Progress units per second; 1.0 covers the whole expanded↔collapsed range, so
/// the animation takes `1.0 / speed` seconds.
///
/// Opening is a direct answer to the cursor arriving, so it is noticeably
/// quicker than closing, which is a passive retreat that reads better unhurried.
const ANIM_SPEED_OPEN: f32 = 14.0;
/// See [`ANIM_SPEED_OPEN`]. Slower, because nothing is waiting on it.
const ANIM_SPEED_CLOSE: f32 = 6.0;
/// How long the window must sit still before a drag counts as finished.
///
/// The compositor cannot report the end of a drag, so the loop watches for one.
/// The physical mouse button is the authoritative signal (see [`crate::pointer`]);
/// this window is the fallback for when the platform cannot report it.
const DRAG_SETTLE: Duration = Duration::from_millis(250);
/// Settle window once the release is known, so only the final frame has to land.
const DRAG_SETTLE_RELEASE: Duration = Duration::from_millis(120);
/// How long the window takes to glide onto the envelope it docked to.
///
/// Deliberately longer than the collapse, which `ANIM_SPEED_CLOSE` finishes in
/// about 170 ms: the fold happens on the way, and the travel stays legible after it
/// is done, so the move is seen rather than inferred.
const SNAP_TRAVEL: Duration = Duration::from_millis(320);
/// Slack around the interactive content, in logical pixels.
const HIT_SLACK: f64 = 2.0;

/// Whether to log drag lifecycle events.
///
/// A compositor drag is otherwise a black box: the overlay state, the settle
/// decisions and the final position all happen with no visible signal, so a
/// single real drag is worth more than any amount of reading the source.
pub fn trace_enabled() -> bool {
    use std::sync::OnceLock;

    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var("MECHANICUS_COMPANION_TAURI_TRACE").as_deref() == Ok("1"))
}

/// Runtime-resolved snap radius, read once.
pub fn snap_radius() -> f64 {
    use std::sync::OnceLock;
    static VALUE: OnceLock<f64> = OnceLock::new();
    *VALUE.get_or_init(|| {
        std::env::var("MECHANICUS_COMPANION_TAURI_SNAP_PX")
            .ok()
            .and_then(|v| v.trim().parse::<f64>().ok())
            .filter(|v| v.is_finite() && *v >= 0.0)
            .unwrap_or(SNAP_RADIUS_DEFAULT)
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SnapTarget {
    Left,
    Right,
    Bottom,
}

impl SnapTarget {
    pub const ALL: [SnapTarget; 3] = [SnapTarget::Left, SnapTarget::Right, SnapTarget::Bottom];

    pub fn as_u8(self) -> u8 {
        match self {
            SnapTarget::Left => 1,
            SnapTarget::Right => 2,
            SnapTarget::Bottom => 3,
        }
    }

    /// Inverse of [`SnapTarget::as_u8`], for decoding the atomic target flag.
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            1 => Some(SnapTarget::Left),
            2 => Some(SnapTarget::Right),
            3 => Some(SnapTarget::Bottom),
            _ => None,
        }
    }

    /// Window size while docked here: the union of both footprints.
    pub fn window_size(self, content: (f64, f64)) -> (f64, f64) {
        match self {
            SnapTarget::Left | SnapTarget::Right => {
                (content.0.max(HANDLE_THICK), content.1.max(HANDLE_LONG))
            }
            SnapTarget::Bottom => (content.0.max(HANDLE_LONG), content.1.max(HANDLE_THICK)),
        }
    }

    /// Where the window sits while docked here, in top-left screen coordinates.
    pub fn window_pos(self, work: Rect, size: (f64, f64)) -> (f64, f64) {
        // Clamped so a work area smaller than the overlay (a very large Dock)
        // cannot push a target off the top or left of the screen.
        let max_y = (work.y + work.h - size.1).max(work.y);
        let max_x = (work.x + work.w - size.0).max(work.x);
        match self {
            SnapTarget::Left => (
                work.x,
                clamp(work.y + (work.h - size.1) / 2.0, work.y, max_y),
            ),
            SnapTarget::Right => (
                clamp(work.x + work.w - size.0, work.x, max_x),
                clamp(work.y + (work.h - size.1) / 2.0, work.y, max_y),
            ),
            SnapTarget::Bottom => (
                clamp(work.x + (work.w - size.0) / 2.0, work.x, max_x),
                clamp(work.y + work.h - size.1, work.y, max_y),
            ),
        }
    }

    /// The collapsed handle's footprint, in window-local coordinates.
    pub fn handle_rect(self, size: (f64, f64)) -> Rect {
        let (w, h) = size;
        match self {
            SnapTarget::Left => Rect {
                x: 0.0,
                y: (h - HANDLE_LONG) / 2.0,
                w: HANDLE_THICK,
                h: HANDLE_LONG,
            },
            SnapTarget::Right => Rect {
                x: w - HANDLE_THICK,
                y: (h - HANDLE_LONG) / 2.0,
                w: HANDLE_THICK,
                h: HANDLE_LONG,
            },
            SnapTarget::Bottom => Rect {
                x: (w - HANDLE_LONG) / 2.0,
                y: h - HANDLE_THICK,
                w: HANDLE_LONG,
                h: HANDLE_THICK,
            },
        }
    }

    /// The expanded overlay's footprint, in window-local coordinates.
    pub fn expanded_rect(self, size: (f64, f64), content: (f64, f64)) -> Rect {
        let (w, h) = size;
        let (cw, ch) = content;
        match self {
            SnapTarget::Left => Rect {
                x: 0.0,
                y: (h - ch) / 2.0,
                w: cw,
                h: ch,
            },
            SnapTarget::Right => Rect {
                x: w - cw,
                y: (h - ch) / 2.0,
                w: cw,
                h: ch,
            },
            SnapTarget::Bottom => Rect {
                x: (w - cw) / 2.0,
                y: h - ch,
                w: cw,
                h: ch,
            },
        }
    }

    /// Marker shown on the dim overlay while dragging, in screen coordinates.
    ///
    /// It previews the collapsed handle's footprint, padded so the capsule is
    /// visible around it. Where the handle sits flush with the work-area edge that
    /// padding is held inside instead of overflowing, because the overlay window
    /// ends at the edge and anything past it is clipped.
    pub fn pill_rect(self, work: Rect, content: (f64, f64)) -> Rect {
        let size = self.window_size(content);
        let pos = self.window_pos(work, size);
        let handle = self.handle_rect(size);
        let w = handle.w + PILL_PAD * 2.0;
        let h = handle.h + PILL_PAD * 2.0;
        Rect {
            x: clamp(
                pos.0 + handle.x - PILL_PAD,
                work.x + PILL_MARGIN,
                work.x + work.w - PILL_MARGIN - w,
            ),
            y: clamp(
                pos.1 + handle.y - PILL_PAD,
                work.y + PILL_MARGIN,
                work.y + work.h - PILL_MARGIN - h,
            ),
            w,
            h,
        }
    }

    /// Centre of the docked window, used to decide which target a drop is near.
    fn center(self, work: Rect, content: (f64, f64)) -> (f64, f64) {
        let size = self.window_size(content);
        let pos = self.window_pos(work, size);
        (pos.0 + size.0 / 2.0, pos.1 + size.1 / 2.0)
    }
}

/// Nearest target to a window rect, and how far its centre is from the target.
pub fn nearest_target(win: Rect, work: Rect, content: (f64, f64)) -> (SnapTarget, f64) {
    let center = (win.x + win.w / 2.0, win.y + win.h / 2.0);
    SnapTarget::ALL
        .into_iter()
        .map(|target| {
            let (tx, ty) = target.center(work, content);
            let d = ((center.0 - tx).powi(2) + (center.1 - ty).powi(2)).sqrt();
            (target, d)
        })
        .min_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
        .unwrap_or((SnapTarget::Right, f64::INFINITY))
}

/// The target a drop should dock to, or `None` when it landed too far away.
pub fn resolve_drop(win: Rect, work: Rect, content: (f64, f64)) -> Option<SnapTarget> {
    let (target, distance) = nearest_target(win, work, content);
    (distance <= snap_radius()).then_some(target)
}

/// Cubic ease-out, so the handle settles instead of stopping abruptly.
pub fn ease(t: f32) -> f32 {
    let u = 1.0 - clamp_f32(t, 0.0, 1.0);
    1.0 - u * u * u
}

/// Pace for an animation heading from `progress` towards `goal`.
///
/// Progress falls towards 0 while opening and rises towards 1 while collapsing,
/// so the direction of travel decides the pace. Extracted from the loop so the
/// "opening is quicker" relationship can be pinned by a test rather than
/// depending on someone re-deriving it from two constants.
fn anim_speed(progress: f32, goal: f32) -> f32 {
    if goal < progress {
        ANIM_SPEED_OPEN
    } else {
        ANIM_SPEED_CLOSE
    }
}

fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}

/// Where a dock travel has reached at `t`, in linear time 0..=1.
///
/// Eased, so the window leaves the drop point at speed and settles onto the edge
/// rather than stopping dead on it.
fn travel_position(from: (f64, f64), goal: (f64, f64), t: f32) -> (f64, f64) {
    let e = ease(t) as f64;
    (lerp(from.0, goal.0, e), lerp(from.1, goal.1, e))
}

/// Window position that puts the content's origin at `content_origin`.
///
/// The envelope is not always the content's size: a bottom dock's envelope is at
/// least the handle's length, which is wider than a one-button row, so the content
/// sits inset inside it. Starting a travel from the raw window position would
/// therefore make the button jump sideways by that inset on the very frame the
/// envelope is applied — before the glide has moved anything. Deriving the start
/// from the content instead keeps it continuous.
/// A measured size within this much of the envelope is not drift.
const ENVELOPE_SIZE_TOLERANCE: f64 = 0.5;

/// Whether the envelope has to be applied this tick.
///
/// The measured size is part of the test, not just the last envelope recorded as
/// applied: the poll loop sizes the window too, and if it lands between the snap
/// loop's read of the target and its write, the window keeps the floating footprint
/// while `applied` says otherwise -- leaving it the wrong size, with the content rect
/// describing a window that is not there, until the target or the agent set changes.
fn needs_envelope(applied: Option<Rect>, env: Rect, win: Rect) -> bool {
    applied != Some(env)
        || (win.w - env.w).abs() > ENVELOPE_SIZE_TOLERANCE
        || (win.h - env.h).abs() > ENVELOPE_SIZE_TOLERANCE
}

/// Where the window must sit so the content does not move across a drop.
///
/// During a drag the window keeps the geometry the last docked frame gave it, and
/// the content is drawn *inside* it at `content_rect(progress)` — not at its
/// origin. The drop frame re-renders the content expanded, so the window has to
/// absorb the difference; without that the button jumps by it on the frame before
/// the glide starts, which is the one frame the glide cannot hide.
///
/// When the drag began with the content already expanded the two rects agree and
/// this is the identity — the common case, and the one to check first if a jump
/// ever comes back.
fn travel_start(
    window: (f64, f64),
    content_before: (f64, f64),
    content_after: (f64, f64),
) -> (f64, f64) {
    (
        window.0 + content_before.0 - content_after.0,
        window.1 + content_before.1 - content_after.1,
    )
}

fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    if hi < lo {
        lo
    } else {
        v.max(lo).min(hi)
    }
}

fn clamp_f32(v: f32, lo: f32, hi: f32) -> f32 {
    if hi < lo {
        lo
    } else {
        v.max(lo).min(hi)
    }
}

/// Interpolates the visible content between expanded and collapsed.
pub fn content_rect(
    target: SnapTarget,
    size: (f64, f64),
    content: (f64, f64),
    progress: f32,
) -> Rect {
    let t = clamp_f32(progress, 0.0, 1.0) as f64;
    let from = target.expanded_rect(size, content);
    let to = target.handle_rect(size);
    Rect {
        x: lerp(from.x, to.x, t),
        y: lerp(from.y, to.y, t),
        w: lerp(from.w, to.w, t),
        h: lerp(from.h, to.h, t),
    }
}

// ── Shared state ───────────────────────────────────────────────────────────

#[derive(Clone, Serialize, PartialEq)]
pub struct SnapPayload {
    pub snapped: bool,
    pub target: Option<SnapTarget>,
    /// 0 = expanded, 1 = collapsed.
    pub progress: f32,
    /// Window-local content rect, in logical pixels.
    pub content: [f64; 4],
    pub expanded: bool,
    /// Window-local pointer position while it is inside the interactive area, in
    /// logical pixels. `None` outside it, so a moving pointer elsewhere in the
    /// screen does not emit.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<[f64; 2]>,
}

/// One landing-spot marker, in overlay-local coordinates.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Pill {
    pub target: SnapTarget,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Everything the dim overlay needs for one frame.
#[derive(Clone, Serialize, PartialEq, Default)]
pub struct OverlayState {
    pub active: bool,
    pub pills: Vec<Pill>,
    /// Target the overlay would dock to if released now.
    pub nearest: Option<SnapTarget>,
}

struct Inner {
    target: Option<SnapTarget>,
    progress: f32,
    hover_expanded: bool,
    /// Expanded content size, refreshed from the plugin state payload.
    content: (f64, f64),
    /// Envelope currently applied to the native window.
    applied: Option<Rect>,
    dragging: bool,
    drag_end_hint: bool,
    /// Test hook: keeps a simulated drag open until explicitly released.
    ///
    /// Settle detection exists because a real compositor drag cannot report its
    /// own end; a scripted drag can, so it says so instead of waiting out the
    /// settle window and losing the frame it wanted to observe.
    hold_open: bool,
    last_drag_pos: Option<(i32, i32)>,
    last_drag_change: Instant,
    /// Where the drag was when the loop first saw it, for diagnostics.
    drag_start_pos: Option<(i32, i32)>,
    screen: Option<ScreenInfo>,
    /// Nearest target for the current drag position.
    drag_nearest: Option<SnapTarget>,
    /// Glide towards the docked envelope, started by a drop.
    travel: Option<Travel>,
}

/// A window moving from where it was dropped onto the envelope it docked to.
///
/// Without it the window is teleported on the frame after release: the drop lands
/// on the target, `applied` is cleared, and the next tick pins the window to the
/// edge. The button then appears to cut to the edge and only afterwards collapse,
/// so the one part the user is watching — it travelling to where it will live — is
/// the part with no motion.
///
/// Only the position is animated. The envelope is never resized per frame (see the
/// module docs); its size is applied once, and the collapse animation inside it runs
/// concurrently, so the button arrives already folded into a handle.
///
/// Always cleared before the state it describes goes away -- on a drag, on a drop
/// that finds no target, and on disable. Leaving one set happens to be harmless
/// (its elapsed time is long past `SNAP_TRAVEL`, so it lands and clears in a single
/// frame), but that is a property of the clock rather than of this state.
struct Travel {
    from: (f64, f64),
    started: Instant,
}

pub struct SnapController {
    inner: Mutex<Inner>,
    enabled: AtomicBool,
    /// Target as a `u8` so readers can check it without locking.
    target_bits: AtomicU8,
}

impl SnapController {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(Inner {
                target: None,
                progress: 0.0,
                hover_expanded: true,
                content: (120.0, 120.0),
                applied: None,
                dragging: false,
                drag_end_hint: false,
                hold_open: false,
                last_drag_pos: None,
                last_drag_change: Instant::now(),
                drag_start_pos: None,
                screen: None,
                drag_nearest: None,
                travel: None,
            }),
            enabled: AtomicBool::new(true),
            target_bits: AtomicU8::new(0),
        })
    }

    /// Installs freshly measured screen geometry (main thread).
    pub fn set_screen(&self, screen: ScreenInfo) {
        let mut inner = self.inner.lock().unwrap();
        if inner.screen != Some(screen) {
            inner.screen = Some(screen);
            // Targets move when the work area changes, so re-apply.
            inner.applied = None;
        }
    }

    /// Current screen geometry, for diagnostics and placement decisions.
    pub fn screen(&self) -> Option<ScreenInfo> {
        self.inner.lock().unwrap().screen
    }

    pub fn set_enabled(&self, on: bool) {
        self.enabled.store(on, Ordering::Relaxed);
        if !on {
            let mut inner = self.inner.lock().unwrap();
            inner.target = None;
            inner.progress = 0.0;
            inner.applied = None;
            inner.drag_nearest = None;
            inner.travel = None;
            self.target_bits.store(0, Ordering::Relaxed);
        }
    }

    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    /// Reports the expanded content size (driven by the agent grid).
    pub fn set_content_size(&self, w: f64, h: f64) {
        let mut inner = self.inner.lock().unwrap();
        if inner.content != (w, h) {
            inner.content = (w, h);
            inner.applied = None;
        }
    }

    pub fn begin_drag(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.dragging = true;
        inner.drag_end_hint = false;
        inner.last_drag_pos = None;
        inner.last_drag_change = Instant::now();
        inner.drag_start_pos = None;
        inner.drag_nearest = None;
        inner.travel = None;

        if trace_enabled() {
            // A drag can only have started from a pressed button, so anything
            // other than `true` here means the platform query is unreliable and
            // the drag will end on the settle timer alone.
            eprintln!(
                "[drag] begin button_down={:?}",
                pointer::primary_button_down()
            );
        }
    }

    /// Frontend hint that the pointer is up: shortens the settle window only.
    pub fn hint_drag_end(&self) {
        let mut inner = self.inner.lock().unwrap();
        if inner.dragging {
            inner.drag_end_hint = true;
        }
        inner.hold_open = false;
    }

    /// Test hook: start a drag that stays open until [`Self::release_drag`].
    pub fn begin_held_drag(&self) {
        self.begin_drag();
        self.inner.lock().unwrap().hold_open = true;
    }

    /// Test hook: end a drag started by [`Self::begin_held_drag`].
    ///
    /// Only clears the hold so the normal settle path runs: the loop decides
    /// when the drag is over, exactly as it does for a real release.
    pub fn release_drag(&self) {
        self.hint_drag_end();
    }

    pub fn is_snapped(&self) -> bool {
        self.target_bits.load(Ordering::Relaxed) != 0
    }

    /// The edge the overlay is docked to, if any.
    ///
    /// The state poller reads this to lay the buttons out along that edge: a
    /// side dock stacks them in one column, the bottom dock in one row.
    pub fn target(&self) -> Option<SnapTarget> {
        SnapTarget::from_u8(self.target_bits.load(Ordering::Relaxed))
    }

    /// Whether a drag is in flight. The state poller must not resize the window
    /// while it is true: the compositor owns its geometry until release.
    pub fn is_dragging(&self) -> bool {
        self.inner.lock().unwrap().dragging
    }

    /// Snapshot for the dim overlay.
    ///
    /// The overlay polls this from its own webview rather than listening for
    /// pushed events, so highlighting keeps working even if the main thread is
    /// busy inside the drag loop.
    pub fn overlay_state(&self) -> OverlayState {
        let inner = self.inner.lock().unwrap();
        let Some(screen) = inner.screen else {
            return OverlayState::default();
        };
        if !inner.dragging {
            return OverlayState::default();
        }
        OverlayState {
            active: true,
            pills: SnapTarget::ALL
                .into_iter()
                .map(|target| {
                    let rect = target.pill_rect(screen.work, inner.content);
                    Pill {
                        target,
                        x: rect.x - screen.frame.x,
                        y: rect.y - screen.frame.y,
                        w: rect.w,
                        h: rect.h,
                    }
                })
                .collect(),
            nearest: inner.drag_nearest,
        }
    }
}

/// Drives hover detection, the collapse/expand animation, and click-through.
pub fn spawn(
    window: WebviewWindow,
    controller: Arc<SnapController>,
    cursor: crate::CursorSource,
    on_change: impl Fn(SnapPayload) + Send + 'static,
    on_drag_visibility: impl Fn(bool) + Send + 'static,
) {
    std::thread::spawn(move || {
        let mut last_emitted: Option<SnapPayload> = None;
        let mut hover_since: Option<Instant> = None;
        let mut leave_since: Option<Instant> = None;
        // tao dispatches `setIgnoresMouseEvents` asynchronously onto the main
        // queue, so only call it on transitions to avoid piling up work.
        let mut last_ignore: Option<bool> = None;
        let mut last_overlay: Option<bool> = None;

        loop {
            std::thread::sleep(TICK);

            if !controller.enabled() {
                continue;
            }

            let Some((cursor_x, cursor_y)) = cursor.position(&window) else {
                continue;
            };
            let Ok(scale) = window.scale_factor() else {
                continue;
            };
            if scale <= 0.0 {
                continue;
            }
            // `outer_position` reads NSWindow.frame directly, so it keeps
            // working while the main thread is inside the drag loop.
            let Ok(pos) = window.outer_position() else {
                continue;
            };
            let Ok(size) = window.outer_size() else {
                continue;
            };

            let win = Rect {
                x: pos.x as f64 / scale,
                y: pos.y as f64 / scale,
                w: size.width as f64 / scale,
                h: size.height as f64 / scale,
            };
            let cursor_local = (
                (cursor_x - pos.x as f64) / scale,
                (cursor_y - pos.y as f64) / scale,
            );

            let (payload_snapshot, desired_ignore, env_to_apply, pos_to_apply);

            {
                let mut inner = controller.inner.lock().unwrap();

                // ── Drag settling ──────────────────────────────────────────
                if inner.dragging {
                    let now_pos = (pos.x, pos.y);
                    if inner.drag_start_pos.is_none() {
                        inner.drag_start_pos = Some(now_pos);
                    }
                    if inner.last_drag_pos != Some(now_pos) {
                        inner.last_drag_pos = Some(now_pos);
                        inner.last_drag_change = Instant::now();
                    }
                    if let Some(screen) = inner.screen {
                        inner.drag_nearest = resolve_drop(win, screen.work, inner.content);
                    }

                    // A pause mid-drag must not read as a release: the position
                    // stopping is not the button coming up. Only end the drag
                    // once the button is known to be released.
                    let button = pointer::primary_button_down();
                    let held = button == Some(true);
                    let released = button == Some(false);
                    let settle = if released || inner.drag_end_hint {
                        DRAG_SETTLE_RELEASE
                    } else {
                        DRAG_SETTLE
                    };
                    if !held && !inner.hold_open && inner.last_drag_change.elapsed() >= settle {
                        inner.dragging = false;
                        inner.drag_end_hint = false;
                        let dropped = inner
                            .screen
                            .and_then(|s| resolve_drop(win, s.work, inner.content));
                        match dropped {
                            Some(target) => {
                                inner.target = Some(target);
                                // The window is still where the drag left it;
                                // recompute and re-apply so it lands on target.
                                inner.applied = None;
                                inner.hover_expanded = false;
                                // The content is about to be re-rendered expanded.
                                // Where it was drawn a moment ago is what the travel
                                // has to start from, so read it before the reset.
                                let dims = target.window_size(inner.content);
                                let content_before =
                                    content_rect(target, dims, inner.content, ease(inner.progress));
                                inner.progress = 0.0;
                                let content_after = target.expanded_rect(dims, inner.content);
                                inner.travel = Some(Travel {
                                    from: travel_start(
                                        (win.x, win.y),
                                        (content_before.x, content_before.y),
                                        (content_after.x, content_after.y),
                                    ),
                                    started: Instant::now(),
                                });
                                if trace_enabled() {
                                    // Continuity is a claim about the content, and the
                                    // window moving is expected -- only this line shows
                                    // both, which is what makes a jump diagnosable
                                    // rather than a matter of opinion.
                                    eprintln!(
                                        "[drop] target={target:?} win=({:.1},{:.1}) content_before=({:.1},{:.1}) content_after=({:.1},{:.1}) from={:?}",
                                        win.x,
                                        win.y,
                                        content_before.x,
                                        content_before.y,
                                        content_after.x,
                                        content_after.y,
                                        inner.travel.as_ref().map(|t| t.from),
                                    );
                                }
                                controller
                                    .target_bits
                                    .store(target.as_u8(), Ordering::Relaxed);
                            }
                            None => {
                                inner.target = None;
                                inner.applied = None;
                                inner.travel = None;
                                controller.target_bits.store(0, Ordering::Relaxed);
                            }
                        }
                        inner.drag_nearest = None;

                        if trace_enabled() {
                            let from = inner.drag_start_pos.unwrap_or(now_pos);
                            eprintln!(
                                "[drag] end from={from:?} to={now_pos:?} moved={:?} released={released} target={:?}",
                                (now_pos.0 - from.0, now_pos.1 - from.1),
                                inner.target,
                            );
                        }
                    }
                }

                if inner.dragging {
                    // The compositor owns the window while it is being dragged:
                    // leave its geometry alone and keep it interactive.
                    hover_since = None;
                    leave_since = None;
                    drop(inner);
                    if last_overlay != Some(true) {
                        on_drag_visibility(true);
                        last_overlay = Some(true);
                    }
                    if last_ignore != Some(false) {
                        let _ = window.set_ignore_cursor_events(false);
                        last_ignore = Some(false);
                    }
                    continue;
                }

                if last_overlay != Some(false) {
                    on_drag_visibility(false);
                    last_overlay = Some(false);
                }

                let Some(target) = inner.target else {
                    // Free floating: the whole window is the overlay.
                    if inner.progress != 0.0 {
                        inner.progress = 0.0;
                    }
                    desired_ignore = false;
                    drop(inner);
                    let payload = SnapPayload {
                        snapped: false,
                        target: None,
                        progress: 0.0,
                        content: [0.0, 0.0, win.w, win.h],
                        expanded: true,
                        // Floating, the whole window is interactive.
                        cursor: point_in(
                            cursor_local,
                            Rect {
                                x: 0.0,
                                y: 0.0,
                                w: win.w,
                                h: win.h,
                            },
                            0.0,
                        )
                        .then_some([cursor_local.0, cursor_local.1]),
                    };
                    if last_emitted.as_ref() != Some(&payload) {
                        on_change(payload.clone());
                        last_emitted = Some(payload);
                    }
                    if last_ignore != Some(desired_ignore) {
                        let _ = window.set_ignore_cursor_events(desired_ignore);
                        last_ignore = Some(desired_ignore);
                    }
                    continue;
                };

                let Some(screen) = inner.screen else {
                    drop(inner);
                    continue;
                };

                let dims = target.window_size(inner.content);
                let target_pos = target.window_pos(screen.work, dims);
                let env = Rect {
                    x: target_pos.0,
                    y: target_pos.1,
                    w: dims.0,
                    h: dims.1,
                };

                // Apply the envelope only when it changes: this is what moves the
                // overlay onto the target after a drop, or when the work area (and
                // therefore the target) shifts.
                env_to_apply = if needs_envelope(inner.applied, env, win) {
                    inner.applied = Some(env);
                    Some(env)
                } else {
                    None
                };

                // Position: owned by the travel while one is running, otherwise
                // pinned to the envelope and only touched when it changes.
                pos_to_apply = match inner.travel.as_mut() {
                    Some(travel) => {
                        let elapsed = travel.started.elapsed().as_secs_f64();
                        let t = (elapsed / SNAP_TRAVEL.as_secs_f64()).min(1.0) as f32;
                        let at = travel_position(travel.from, (env.x, env.y), t);
                        if t >= 1.0 {
                            inner.travel = None;
                        }
                        Some(at)
                    }
                    None => env_to_apply.map(|e| (e.x, e.y)),
                };

                let handle = target.handle_rect(dims);
                let expanded = target.expanded_rect(dims, inner.content);
                let over_handle = point_in(cursor_local, handle, 6.0);
                let over_expanded = point_in(cursor_local, expanded, 2.0);

                if inner.hover_expanded {
                    // A fresh placement must not immediately collapse: the
                    // cursor is still wherever the drop happened.
                    if over_expanded || env_to_apply.is_some() {
                        leave_since = None;
                    } else if leave_since.is_none() {
                        leave_since = Some(Instant::now());
                    } else if leave_since
                        .map(|t| t.elapsed() >= HOVER_CLOSE_DELAY)
                        .unwrap_or(false)
                    {
                        inner.hover_expanded = false;
                        leave_since = None;
                    }
                } else if over_handle {
                    if hover_since.is_none() {
                        hover_since = Some(Instant::now());
                    } else if hover_since
                        .map(|t| t.elapsed() >= HOVER_OPEN_DELAY)
                        .unwrap_or(false)
                    {
                        inner.hover_expanded = true;
                        hover_since = None;
                    }
                } else {
                    hover_since = None;
                }

                let goal = if inner.hover_expanded { 0.0 } else { 1.0 };
                let delta = anim_speed(inner.progress, goal) * (TICK.as_secs_f32());
                if (inner.progress - goal).abs() <= delta {
                    inner.progress = goal;
                } else if inner.progress < goal {
                    inner.progress += delta;
                } else {
                    inner.progress -= delta;
                }

                let content = content_rect(target, dims, inner.content, ease(inner.progress));

                // Click-through follows the visible content, never the
                // envelope: whatever is not being drawn must stay transparent.
                let visible = if inner.hover_expanded && inner.progress <= 0.001 {
                    expanded
                } else if !inner.hover_expanded && inner.progress >= 0.999 {
                    handle
                } else {
                    union_rect(content, expanded)
                };
                let interactive = expand_rect(visible, HIT_SLACK);
                desired_ignore = !point_in(cursor_local, interactive, 0.0);

                payload_snapshot = SnapPayload {
                    snapped: true,
                    target: Some(target),
                    progress: inner.progress,
                    content: [content.x, content.y, content.w, content.h],
                    expanded: inner.hover_expanded,
                    // Published only while the pointer is inside: the frontend paints
                    // the hover from this, and sending it constantly would emit on
                    // every frame the mouse moves anywhere on the screen.
                    cursor: if point_in(cursor_local, interactive, 0.0) {
                        Some([cursor_local.0, cursor_local.1])
                    } else {
                        None
                    },
                };
            }

            if let Some(env) = env_to_apply {
                let _ = window.set_size(LogicalSize::new(env.w, env.h));
            }

            if let Some((x, y)) = pos_to_apply {
                let _ = window.set_position(LogicalPosition::new(x, y));
            }

            if last_ignore != Some(desired_ignore) {
                let _ = window.set_ignore_cursor_events(desired_ignore);
                last_ignore = Some(desired_ignore);
            }

            if last_emitted.as_ref() != Some(&payload_snapshot) {
                on_change(payload_snapshot.clone());
                last_emitted = Some(payload_snapshot);
            }
        }
    });
}

fn point_in(p: (f64, f64), r: Rect, slack: f64) -> bool {
    p.0 >= r.x - slack && p.0 <= r.x + r.w + slack && p.1 >= r.y - slack && p.1 <= r.y + r.h + slack
}

/// Grows a rect by `slack` on every side, for a slightly forgiving hit target.
fn expand_rect(r: Rect, slack: f64) -> Rect {
    Rect {
        x: r.x - slack,
        y: r.y - slack,
        w: r.w + slack * 2.0,
        h: r.h + slack * 2.0,
    }
}

fn union_rect(a: Rect, b: Rect) -> Rect {
    let x = a.x.min(b.x);
    let y = a.y.min(b.y);
    let x2 = (a.x + a.w).max(b.x + b.w);
    let y2 = (a.y + a.h).max(b.y + b.h);
    Rect {
        x,
        y,
        w: x2 - x,
        h: y2 - y,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 1080-tall display with a 70pt Dock and a 25pt menu bar.
    const WORK: Rect = Rect {
        x: 0.0,
        y: 25.0,
        w: 1920.0,
        h: 985.0,
    };
    const CONTENT: (f64, f64) = (80.0, 80.0);

    #[test]
    fn left_and_right_are_flush_and_vertically_centred() {
        let size = SnapTarget::Right.window_size(CONTENT);
        let (x, y) = SnapTarget::Right.window_pos(WORK, size);
        assert_eq!(x + size.0, WORK.x + WORK.w, "right edge flush");
        assert_eq!(
            y + size.1 / 2.0,
            WORK.y + WORK.h / 2.0,
            "centred in work area"
        );

        let left = SnapTarget::Left.window_size(CONTENT);
        let (lx, _) = SnapTarget::Left.window_pos(WORK, left);
        assert_eq!(lx, WORK.x, "left edge flush");
    }

    #[test]
    fn bottom_is_flush_above_the_dock_and_horizontally_centred() {
        let size = SnapTarget::Bottom.window_size(CONTENT);
        let (x, y) = SnapTarget::Bottom.window_pos(WORK, size);
        assert_eq!(y + size.1, WORK.y + WORK.h, "sits on the Dock top edge");
        assert_eq!(
            x + size.0 / 2.0,
            WORK.x + WORK.w / 2.0,
            "centred horizontally"
        );
    }

    #[test]
    fn envelope_holds_both_footprints_for_every_target() {
        for target in SnapTarget::ALL {
            let size = target.window_size(CONTENT);
            for progress in [0.0, 0.5, 1.0] {
                let c = content_rect(target, size, CONTENT, progress);
                assert!(
                    c.x >= -0.001
                        && c.y >= -0.001
                        && c.x + c.w <= size.0 + 0.001
                        && c.y + c.h <= size.1 + 0.001,
                    "content {c:?} escaped envelope {size:?} for {target:?} at {progress}"
                );
            }
        }
    }

    #[test]
    fn collapsed_content_matches_the_handle() {
        for target in SnapTarget::ALL {
            let size = target.window_size(CONTENT);
            let collapsed = content_rect(target, size, CONTENT, 1.0);
            let handle = target.handle_rect(size);
            assert!((collapsed.x - handle.x).abs() < 0.001);
            assert!((collapsed.y - handle.y).abs() < 0.001);
            assert!((collapsed.w - handle.w).abs() < 0.001);
            assert!((collapsed.h - handle.h).abs() < 0.001);
        }
    }

    #[test]
    fn docked_states_stay_against_their_edge() {
        // Collapsed and expanded must both hug the docked edge: the overlay
        // travels along the edge, never away from it.
        for target in SnapTarget::ALL {
            let size = target.window_size(CONTENT);
            for progress in [0.0, 1.0] {
                let c = content_rect(target, size, CONTENT, progress);
                match target {
                    SnapTarget::Left => assert!(c.x.abs() < 0.001, "left flush"),
                    SnapTarget::Right => {
                        assert!((c.x + c.w - size.0).abs() < 0.001, "right flush")
                    }
                    SnapTarget::Bottom => {
                        assert!((c.y + c.h - size.1).abs() < 0.001, "bottom flush")
                    }
                }
            }
        }
    }

    #[test]
    fn the_pill_marker_stays_whole_inside_the_work_area() {
        // The overlay window ends at the work area, so any part of the marker past
        // that is clipped: an edge target's handle is flush with the edge, and
        // padding it outward there used to cut the capsule's rounded end off.
        for target in SnapTarget::ALL {
            let pill = target.pill_rect(WORK, CONTENT);
            let margin = PILL_MARGIN - 0.001;
            assert!(
                pill.x >= WORK.x + margin,
                "{target:?} marker overflows the left edge: {pill:?}"
            );
            assert!(
                pill.y >= WORK.y + margin,
                "{target:?} marker overflows the top edge: {pill:?}"
            );
            assert!(
                pill.x + pill.w <= WORK.x + WORK.w - margin,
                "{target:?} marker overflows the right edge: {pill:?}"
            );
            assert!(
                pill.y + pill.h <= WORK.y + WORK.h - margin,
                "{target:?} marker overflows the bottom edge: {pill:?}"
            );
        }
    }

    #[test]
    fn the_pill_marker_still_previews_the_handle() {
        for target in SnapTarget::ALL {
            let size = target.window_size(CONTENT);
            let (wx, wy) = target.window_pos(WORK, size);
            let handle = target.handle_rect(size);
            let pill = target.pill_rect(WORK, CONTENT);

            // The handle footprint, padded for visibility.
            assert!((pill.w - (handle.w + PILL_PAD * 2.0)).abs() < 0.001);
            assert!((pill.h - (handle.h + PILL_PAD * 2.0)).abs() < 0.001);

            // Held inside the work area, the marker is nudged off the handle, so the
            // promise is overlap rather than a shared centre: it still shows where the
            // overlay will land, just not to the pixel.
            let hx = wx + handle.x;
            let hy = wy + handle.y;
            assert!(
                pill.x < hx + handle.w && hx < pill.x + pill.w,
                "{target:?} marker drifted sideways off its handle: {pill:?}"
            );
            assert!(
                pill.y < hy + handle.h && hy < pill.y + pill.h,
                "{target:?} marker drifted vertically off its handle: {pill:?}"
            );
        }
    }

    #[test]
    fn dropping_on_a_target_resolves_to_it() {
        for target in SnapTarget::ALL {
            let size = target.window_size(CONTENT);
            let (x, y) = target.window_pos(WORK, size);
            let win = Rect {
                x,
                y,
                w: size.0,
                h: size.1,
            };
            assert_eq!(resolve_drop(win, WORK, CONTENT), Some(target));
        }
    }

    #[test]
    fn dropping_in_open_space_does_not_snap() {
        // Dead centre of the work area: far from all three targets.
        let win = Rect {
            x: WORK.x + WORK.w / 2.0 - CONTENT.0 / 2.0,
            y: WORK.y + WORK.h / 2.0 - CONTENT.1 / 2.0,
            w: CONTENT.0,
            h: CONTENT.1,
        };
        assert_eq!(resolve_drop(win, WORK, CONTENT), None);
    }

    #[test]
    fn nearest_target_picks_the_closest_of_three() {
        let left = Rect {
            x: 4.0,
            y: 400.0,
            w: CONTENT.0,
            h: CONTENT.1,
        };
        assert_eq!(nearest_target(left, WORK, CONTENT).0, SnapTarget::Left);

        let bottom = Rect {
            x: WORK.w / 2.0,
            y: WORK.y + WORK.h - CONTENT.1 - 5.0,
            w: CONTENT.0,
            h: CONTENT.1,
        };
        assert_eq!(nearest_target(bottom, WORK, CONTENT).0, SnapTarget::Bottom);
    }

    #[test]
    fn overlay_state_is_only_active_during_a_drag() {
        let controller = SnapController::new();
        assert!(
            !controller.overlay_state().active,
            "no screen measured yet, so nothing to show"
        );

        controller.set_screen(ScreenInfo {
            frame: Rect {
                x: 0.0,
                y: 0.0,
                w: WORK.w,
                h: WORK.h + 95.0,
            },
            work: WORK,
        });
        assert!(
            !controller.overlay_state().active,
            "idle must not dim the desktop"
        );

        controller.begin_held_drag();
        let state = controller.overlay_state();
        assert!(state.active, "a drag in flight shows the overlay");
        assert_eq!(state.pills.len(), 3, "one marker per target");

        // Releasing hands control back to the settle path: the loop, not this
        // call, decides when the drag has actually ended.
        controller.release_drag();
        assert!(
            controller.is_dragging(),
            "release only arms the settle window"
        );
    }

    #[test]
    fn pills_are_reported_in_screen_coordinates() {
        // The overlay window spans the whole display, so subtracting the
        // display's origin puts each pill at its real spot regardless of where
        // the display starts.
        let offset = (100.0, 50.0);
        let frame = Rect {
            x: offset.0,
            y: offset.1,
            w: WORK.w,
            h: WORK.h + 95.0,
        };
        let work = Rect {
            x: WORK.x + offset.0,
            y: WORK.y + offset.1,
            ..WORK
        };
        let controller = SnapController::new();
        controller.set_screen(ScreenInfo { frame, work });
        controller.begin_held_drag();

        for pill in controller.overlay_state().pills {
            let expected = pill.target.pill_rect(work, CONTENT);
            assert!((pill.x - (expected.x - frame.x)).abs() < 0.001, "{pill:?}");
            assert!((pill.y - (expected.y - frame.y)).abs() < 0.001, "{pill:?}");
            assert!((pill.w - expected.w).abs() < 0.001);
            assert!((pill.h - expected.h).abs() < 0.001);
        }
    }

    #[test]
    fn target_u8_round_trips() {
        for target in SnapTarget::ALL {
            assert_eq!(SnapTarget::from_u8(target.as_u8()), Some(target));
        }
        assert_eq!(SnapTarget::from_u8(0), None);
        assert_eq!(SnapTarget::from_u8(9), None);
    }

    #[test]
    fn progress_falling_opens_at_the_quicker_pace() {
        // Opening: collapsed (1.0) heading for expanded (0.0).
        assert_eq!(anim_speed(1.0, 0.0), ANIM_SPEED_OPEN);
        assert_eq!(anim_speed(0.4, 0.0), ANIM_SPEED_OPEN);
        // Collapsing: expanded (0.0) heading for collapsed (1.0).
        assert_eq!(anim_speed(0.0, 1.0), ANIM_SPEED_CLOSE);
        assert_eq!(anim_speed(0.6, 1.0), ANIM_SPEED_CLOSE);
    }

    #[test]
    fn opening_is_quicker_than_collapsing() {
        // A speed covers the whole range in 1/speed seconds, so these are the
        // durations the user actually feels.
        let open = 1.0 / ANIM_SPEED_OPEN;
        let close = 1.0 / ANIM_SPEED_CLOSE;
        assert!(
            open < close,
            "opening must stay the quicker of the two: {open}s vs {close}s"
        );
        // Pinned so a change to the feel is deliberate, not a side effect.
        assert!((open - 0.071).abs() < 0.003, "opening ~71 ms, got {open}s");
        assert!(
            (close - 0.167).abs() < 0.003,
            "closing ~167 ms, got {close}s"
        );
    }

    #[test]
    fn ease_is_monotonic_and_bounded() {
        assert_eq!(ease(0.0), 0.0);
        assert_eq!(ease(1.0), 1.0);
        let mut prev = -1.0;
        for i in 0..=20 {
            let v = ease(i as f32 / 20.0);
            assert!(v >= prev, "ease must not go backwards");
            prev = v;
        }
    }

    #[test]
    fn a_travel_starts_at_the_drop_point_and_lands_on_the_envelope() {
        let from = (900.0, 500.0);
        let goal = (1872.0, 540.0);
        assert_eq!(travel_position(from, goal, 0.0), from);
        let (x, y) = travel_position(from, goal, 1.0);
        assert!(
            (x - goal.0).abs() < 0.001,
            "landed at {x}, wanted {}",
            goal.0
        );
        assert!(
            (y - goal.1).abs() < 0.001,
            "landed at {y}, wanted {}",
            goal.1
        );
    }

    #[test]
    fn a_drop_leaves_the_content_where_it_was_drawn() {
        // The window during a drag is whatever the last docked frame left behind,
        // and the content sits *inside* it rather than at its origin. Whatever the
        // content was drawn at before the drop, it has to be in the same place on
        // the first frame of the glide: that frame is the one the glide cannot hide.
        let drop = (900.0, 500.0);
        let goal = (1872.0, 498.0);
        for target in SnapTarget::ALL {
            let dims = target.window_size(CONTENT);
            let after = target.expanded_rect(dims, CONTENT);
            for progress_before in [0.0_f32, 0.5, 1.0] {
                let before = content_rect(target, dims, CONTENT, ease(progress_before));
                let from = travel_start(drop, (before.x, before.y), (after.x, after.y));
                let (wx, wy) = travel_position(from, goal, 0.0);
                assert!(
                    (wx + after.x - (drop.0 + before.x)).abs() < 0.001,
                    "{target:?} at progress {progress_before}: content moved {} -> {}",
                    drop.0 + before.x,
                    wx + after.x
                );
                assert!(
                    (wy + after.y - (drop.1 + before.y)).abs() < 0.001,
                    "{target:?} at progress {progress_before}: content moved {} -> {}",
                    drop.1 + before.y,
                    wy + after.y
                );
            }
        }
    }

    #[test]
    fn a_drop_after_an_expanded_drag_does_not_move_the_window() {
        // With the content already expanded before the press -- the normal case,
        // since hovering is what opens it -- the two rects agree and the window must
        // not move at all. An earlier version subtracted the content's inset here
        // and so produced a jump exactly that wide.
        let drop = (900.0, 500.0);
        for target in SnapTarget::ALL {
            let dims = target.window_size(CONTENT);
            let before = content_rect(target, dims, CONTENT, ease(0.0));
            let after = target.expanded_rect(dims, CONTENT);
            let from = travel_start(drop, (before.x, before.y), (after.x, after.y));
            // Keeps the assertion from going vacuous: if the envelope ever stopped
            // insetting the content, the subtraction this guards against would be a
            // no-op and the bug would return unnoticed.
            assert!(
                after.x != 0.0 || after.y != 0.0,
                "{target:?} envelope no longer insets the content"
            );
            assert!(
                (from.0 - drop.0).abs() < 0.001 && (from.1 - drop.1).abs() < 0.001,
                "{target:?} moved the window on an expanded drop: {from:?} != {drop:?}"
            );
        }
    }

    #[test]
    fn the_envelope_is_reapplied_when_the_window_size_drifted() {
        // The poll loop can resize the window between the snap loop's read of the
        // target and its write, leaving a window the wrong size while the envelope is
        // still believed applied. Comparing the measured size catches that;
        // comparing only the remembered envelope cannot see it at all.
        let env = Rect {
            x: 1872.0,
            y: 480.0,
            w: 48.0,
            h: 90.0,
        };
        let drifted = Rect {
            x: 100.0,
            y: 100.0,
            w: 132.0,
            h: 110.0,
        };
        assert!(needs_envelope(Some(env), env, drifted));
        assert!(!needs_envelope(Some(env), env, env));

        // Sub-pixel differences are not drift: reacting to them would re-apply the
        // size on every tick.
        let near = Rect {
            x: env.x,
            y: env.y,
            w: env.w + 0.4,
            h: env.h - 0.4,
        };
        assert!(!needs_envelope(Some(env), env, near));

        // A different envelope is applied whatever the measurement says.
        let other = Rect {
            x: 0.0,
            y: 0.0,
            w: 16.0,
            h: 84.0,
        };
        assert!(needs_envelope(Some(env), other, other));
        assert!(needs_envelope(None, other, other));
    }

    #[test]
    fn a_travel_leaves_early_and_settles_late() {
        // Eased rather than linear: half way through it is already most of the way
        // there, which is what makes the move read as a glide onto the edge instead
        // of a constant-speed slide.
        let from = (0.0, 0.0);
        let goal = (100.0, 0.0);
        let (mid, _) = travel_position(from, goal, 0.5);
        assert!(mid > 50.0, "expected ease-out past the midpoint, got {mid}");
        assert!(mid < 100.0, "but not arrived yet, got {mid}");

        let mut prev = -1.0;
        for step in 0..=20 {
            let (x, _) = travel_position(from, goal, step as f32 / 20.0);
            assert!(
                x >= prev,
                "travel went backwards at step {step}: {x} < {prev}"
            );
            prev = x;
        }
    }

    #[test]
    fn the_dock_shifts_the_bottom_target_upward() {
        // A taller Dock leaves a shorter work area, so the bottom target must
        // move up with it rather than overlapping the Dock.
        let tall_dock = Rect {
            y: 25.0,
            h: 900.0,
            ..WORK
        };
        let size = SnapTarget::Bottom.window_size(CONTENT);
        let (_, with_dock) = SnapTarget::Bottom.window_pos(WORK, size);
        let (_, taller) = SnapTarget::Bottom.window_pos(tall_dock, size);
        assert!(
            taller < with_dock,
            "bottom target should sit higher when the Dock is taller"
        );
    }
}

//! Window hit region.
//!
//! macOS has no shaped or per-pixel window hit testing: `NSWindow`
//! `ignoresMouseEvents` is an all-or-nothing switch, and overriding
//! `NSView.hitTest` cannot hand a click to another application. The workable
//! technique — the one SDL settled on for the same problem — is to poll the
//! *global* cursor position and toggle that window-level flag.
//!
//! `NSEvent.mouseLocation`, which tao's `cursor_position` wraps, is a global
//! query: it keeps reporting while the window ignores mouse events, and it
//! needs no Accessibility permission. Polling it is what breaks the usual
//! click-through vs. hover deadlock, where a window that ignores the mouse can
//! never learn the cursor came back.

use crate::workarea::Rect;

/// Which part of the window currently accepts clicks.
///
/// Deferred: the snap loop currently computes its click-through toggle inline
/// from the animated content rect, so these variants are exercised by tests
/// only. They remain the intended shape for the circular silhouette, which is
/// why the geometry below is kept and tested.
#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum HitRegion {
    /// The whole window is interactive (free floating).
    Full,
    /// Only this window-local rect is interactive; the rest passes through.
    Rect(Rect),
    /// An ellipse inscribed in the window, for the circular silhouette.
    Ellipse(Rect),
}

// The ellipse path is deferred (see `HitRegion::Ellipse`), so it is exercised
// only by tests until the circular silhouette lands.
#[allow(dead_code)]
impl HitRegion {
    /// Whether a window-local point should reach the window.
    pub fn contains(&self, x: f64, y: f64) -> bool {
        match *self {
            HitRegion::Full => true,
            HitRegion::Rect(r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h,
            HitRegion::Ellipse(r) => inside_ellipse(x, y, r.w, r.h),
        }
    }
}

/// Extra radius, in logical pixels, so a circular rim is easy to grab.
#[allow(dead_code)]
pub const GRAB_SLACK: f64 = 3.0;

/// Point-in-ellipse test against a window-sized rect.
#[allow(dead_code)]
pub fn inside_ellipse(x: f64, y: f64, w: f64, h: f64) -> bool {
    if w <= 0.0 || h <= 0.0 || !x.is_finite() || !y.is_finite() {
        return false;
    }
    let rx = w / 2.0 + GRAB_SLACK;
    let ry = h / 2.0 + GRAB_SLACK;
    let nx = (x - w / 2.0) / rx;
    let ny = (y - h / 2.0) / ry;
    nx * nx + ny * ny <= 1.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f64, y: f64, w: f64, h: f64) -> Rect {
        Rect { x, y, w, h }
    }

    #[test]
    fn full_accepts_everything() {
        assert!(HitRegion::Full.contains(-100.0, -100.0));
        assert!(HitRegion::Full.contains(1e9, 1e9));
    }

    #[test]
    fn rect_accepts_inside_and_rejects_outside() {
        let region = HitRegion::Rect(rect(10.0, 20.0, 22.0, 84.0));
        assert!(region.contains(20.0, 60.0));
        assert!(region.contains(10.0, 20.0), "inclusive top-left");
        assert!(region.contains(32.0, 104.0), "inclusive bottom-right");
        assert!(!region.contains(9.0, 60.0));
        assert!(!region.contains(20.0, 19.0));
        assert!(!region.contains(100.0, 60.0));
    }

    #[test]
    fn ellipse_centre_is_inside() {
        assert!(HitRegion::Ellipse(rect(0.0, 0.0, 120.0, 120.0)).contains(60.0, 60.0));
    }

    #[test]
    fn ellipse_corners_are_outside() {
        let region = HitRegion::Ellipse(rect(0.0, 0.0, 120.0, 120.0));
        for (x, y) in [(1.0, 1.0), (119.0, 1.0), (1.0, 119.0), (119.0, 119.0)] {
            assert!(
                !region.contains(x, y),
                "corner ({x},{y}) should pass through"
            );
        }
    }

    #[test]
    fn ellipse_cardinals_are_inside() {
        let region = HitRegion::Ellipse(rect(0.0, 0.0, 120.0, 120.0));
        for (x, y) in [(60.0, 1.0), (60.0, 119.0), (1.0, 60.0), (119.0, 60.0)] {
            assert!(
                region.contains(x, y),
                "cardinal ({x},{y}) should be grabbable"
            );
        }
    }

    #[test]
    fn ellipse_handles_degenerate_and_non_finite_input() {
        assert!(!inside_ellipse(0.0, 0.0, 0.0, 100.0));
        assert!(!inside_ellipse(0.0, 0.0, 100.0, 0.0));
        assert!(!inside_ellipse(f64::NAN, 0.0, 100.0, 100.0));
        assert!(!inside_ellipse(0.0, f64::INFINITY, 100.0, 100.0));
    }
}

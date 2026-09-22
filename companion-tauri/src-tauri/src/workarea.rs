//! Screen geometry in the coordinate space Tauri uses.
//!
//! Tauri (like winit/tao) reports window positions with a **top-left origin on
//! the primary display**, while AppKit reports screen frames with a
//! **bottom-left origin**. Everything here converts AppKit values into the
//! former, so window placement math never mixes the two.
//!
//! The work area matters for the "above the Dock" snap target: `visibleFrame`
//! already excludes the menu bar and the Dock, which is exactly the usable
//! region, and it adapts when the Dock is hidden or moved.

use objc2_app_kit::NSScreen;
use objc2_foundation::MainThreadMarker;

/// A rectangle in top-left-origin logical coordinates.
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Full and usable geometry of one display.
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
pub struct ScreenInfo {
    /// Full display bounds.
    pub frame: Rect,
    /// Bounds minus the menu bar and Dock.
    pub work: Rect,
}

/// Reads the screen containing `point` (top-left coordinates), falling back to
/// the main screen when the point is on no display.
///
/// Must run on the main thread: `NSScreen` is AppKit.
pub fn screen_at(point: (f64, f64)) -> Option<ScreenInfo> {
    let mtm = MainThreadMarker::new()?;
    let screens = NSScreen::screens(mtm);

    // The primary display defines the origin, and therefore the flip.
    let primary = screens.iter().next()?;
    let primary_frame = primary.frame();
    let primary_height = primary_frame.size.height;

    let to_top_left = |r: objc2_foundation::NSRect| Rect {
        x: r.origin.x,
        y: primary_height - (r.origin.y + r.size.height),
        w: r.size.width,
        h: r.size.height,
    };

    let mut fallback: Option<ScreenInfo> = None;
    for screen in screens.iter() {
        let info = ScreenInfo {
            frame: to_top_left(screen.frame()),
            work: to_top_left(screen.visibleFrame()),
        };
        if fallback.is_none() {
            fallback = Some(info);
        }
        // A half-open test keeps points on the shared border of two displays
        // from matching both.
        if point.0 >= info.frame.x
            && point.0 < info.frame.x + info.frame.w
            && point.1 >= info.frame.y
            && point.1 < info.frame.y + info.frame.h
        {
            return Some(info);
        }
    }
    fallback
}

#[cfg(test)]
mod tests {
    /// The flip is the part that is easy to get wrong, and it cannot be
    /// exercised without AppKit, so the arithmetic is pinned separately.
    fn flip(cocoa_y: f64, height: f64, primary_height: f64) -> f64 {
        primary_height - (cocoa_y + height)
    }

    #[test]
    fn flip_maps_the_bottom_of_the_primary_screen_to_its_height() {
        // A 100pt-tall window sitting on the bottom edge of a 900pt screen has
        // Cocoa origin y = 0, and must land at top-left y = 800.
        assert_eq!(flip(0.0, 100.0, 900.0), 800.0);
    }

    #[test]
    fn flip_maps_the_top_of_the_primary_screen_to_zero() {
        // Flush with the top: Cocoa origin y = 900 - 100.
        assert_eq!(flip(800.0, 100.0, 900.0), 0.0);
    }

    #[test]
    fn flip_handles_a_dock_shrinking_the_visible_frame() {
        // A 70pt Dock leaves visibleFrame at Cocoa y = 70, so the top of the
        // usable area flips to y = 830 for a zero-height probe.
        assert_eq!(flip(70.0, 0.0, 900.0), 830.0);
    }
}

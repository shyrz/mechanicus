//! Physical pointer-button state.
//!
//! The snap loop needs to know whether a drag is still being held. A compositor
//! drag cannot report its own end: `startDragging` only posts a request to the
//! main thread, and the nested drag loop that runs afterwards swallows the
//! release, so the webview never sees a `pointerup` either. The physical button
//! is the only authoritative signal.
//!
//! Watching the window position instead is not enough. The position stops
//! changing whenever the user pauses mid-drag, which is not the same thing as a
//! release, so treating it as one ends the drag and clears the overlay while the
//! button is still down.

/// Whether the primary mouse button is currently held.
///
/// `None` means the platform cannot answer, leaving callers to fall back to
/// watching the window position.
///
/// This is a state query rather than an event tap, so it needs no Accessibility
/// permission. Like tao's `cursor_position`, which reads `NSEvent.mouseLocation`
/// from the same polling thread, it is a read of current input state and is not
/// restricted to the main thread.
#[cfg(target_os = "macos")]
pub fn primary_button_down() -> Option<bool> {
    use objc2_app_kit::NSEvent;

    // The low-order bit of the mask is the primary button.
    Some(NSEvent::pressedMouseButtons() & 1 != 0)
}

#[cfg(not(target_os = "macos"))]
pub fn primary_button_down() -> Option<bool> {
    None
}

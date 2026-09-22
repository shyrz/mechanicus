//! Revealing the host application.
//!
//! A click on the companion reveals the session it is showing, as far as the
//! host allows. Only a TUI can actually focus a session. The desktop app
//! receives `opencode://session/<id>`, hands it to its renderer, and nothing
//! consumes it -- upstream closed the request to open sessions this way as "not
//! planned". What that URL *does* do reliably is raise the app, because the
//! scheme is registered to it.
//!
//! So the desktop path fires the session URL rather than activating the app
//! directly. Today the two are equivalent, but the URL carries the session, so
//! if the host ever learns to focus one this click starts navigating without a
//! change here. Direct activation stays as the fallback for a host that stops
//! handling the scheme.

/// Opens `url` through LaunchServices, reporting whether it was accepted.
///
/// This is how a registered scheme is invoked. LaunchServices routes by scheme,
/// so a host that dropped its registration would not receive it -- hence the
/// fallback in [`reveal_host`].
#[cfg(target_os = "macos")]
fn open_url(url: &str) -> bool {
    std::process::Command::new("open")
        .arg(url)
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(not(target_os = "macos"))]
fn open_url(_url: &str) -> bool {
    false
}

/// Brings the running application with this bundle identifier to the front.
///
/// Returns whether an instance was found and asked to activate. A `false` is
/// not an error: the host may simply not be running.
#[cfg(target_os = "macos")]
pub fn activate_bundle(bundle_id: &str) -> bool {
    use objc2::rc::autoreleasepool;
    use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication};
    use objc2_foundation::NSString;

    autoreleasepool(|_| {
        let identifier = NSString::from_str(bundle_id);
        let running = NSRunningApplication::runningApplicationsWithBundleIdentifier(&identifier);

        let Some(app) = running.iter().next() else {
            return false;
        };

        // Plain activation, not `ActivateIgnoringOtherApps`: the latter is
        // deprecated as of macOS 14 and documented to have no effect there.
        app.activateWithOptions(NSApplicationActivationOptions::empty())
    })
}

#[cfg(not(target_os = "macos"))]
pub fn activate_bundle(_bundle_id: &str) -> bool {
    false
}

/// The URL that asks the host to show `session_id`.
///
/// A blank session still raises the app through the bare scheme; there is
/// nothing better to send when the plugin has not published a session yet.
pub fn session_url(session_id: &str) -> String {
    let trimmed = session_id.trim();
    if trimmed.is_empty() {
        "opencode://".to_string()
    } else {
        format!("opencode://session/{trimmed}")
    }
}

/// Raises the host, preferring its URL scheme and falling back to activating
/// the app directly.
///
/// Returns whether either route was accepted. Best-effort: the caller treats a
/// `false` as "nothing happened", not as something to report to the user.
pub fn reveal_host(session_id: &str, bundle_id: Option<&str>) -> bool {
    if open_url(&session_url(session_id)) {
        return true;
    }
    bundle_id.is_some_and(activate_bundle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_session_url_carries_the_session() {
        // This is the whole point of using the URL over direct activation: the
        // session travels with it, so a host that learns to focus one needs no
        // change here.
        assert_eq!(session_url("ses_abc123"), "opencode://session/ses_abc123");
    }

    #[test]
    fn a_blank_session_falls_back_to_the_bare_scheme() {
        // Still a valid "raise the app" request, and better than building a
        // dangling `opencode://session/`.
        assert_eq!(session_url(""), "opencode://");
        assert_eq!(session_url("   "), "opencode://");
    }

    #[test]
    fn the_session_is_trimmed() {
        assert_eq!(session_url("  ses_x \n"), "opencode://session/ses_x");
    }

    #[test]
    fn an_unknown_bundle_is_reported_without_panicking() {
        // Nothing validates bundle identifiers before they reach AppKit, so a
        // bad value from the state file must not take the process down.
        assert!(!activate_bundle("com.example.definitely-not-running-app"));
    }

    #[test]
    fn an_empty_bundle_is_harmless() {
        assert!(!activate_bundle(""));
    }
}

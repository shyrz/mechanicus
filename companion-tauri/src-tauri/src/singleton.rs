//! Per-owner-session singleton guard.
//!
//! Ported from `companion/src/singleton.rs`. The plugin only guarantees that
//! one companion spawns per session id, so the native side re-checks with a pid
//! file to avoid duplicate overlays after a hard reload.

use std::path::PathBuf;

fn lock_path(owner_session_id: &str) -> PathBuf {
    let safe_owner = owner_session_id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    let base = std::env::var("XDG_DATA_HOME")
        .ok()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".local")
                .join("share")
        });
    base.join("opencode")
        .join("storage")
        .join("mechanicus")
        .join(format!("companion-tauri.{safe_owner}.pid"))
}

fn process_alive(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    // SAFETY: `kill` with signal 0 only probes for existence and permission.
    unsafe { libc_kill(pid, 0) == 0 }
}

#[cfg(unix)]
unsafe fn libc_kill(pid: i32, sig: i32) -> i32 {
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    kill(pid, sig)
}

#[cfg(not(unix))]
unsafe fn libc_kill(_pid: i32, _sig: i32) -> i32 {
    1
}

/// Returns true when this process may run.
pub fn acquire(owner_session_id: &str) -> bool {
    let path = lock_path(owner_session_id);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    if let Ok(existing) = std::fs::read_to_string(&path) {
        if let Ok(pid) = existing.trim().parse::<i32>() {
            if pid != std::process::id() as i32 && process_alive(pid) {
                return false;
            }
        }
    }

    std::fs::write(&path, std::process::id().to_string()).is_ok()
}

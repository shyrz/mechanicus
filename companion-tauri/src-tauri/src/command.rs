//! Companion → plugin requests.
//!
//! The companion is a detached process, so the filesystem is the entire
//! contract. The plugin writes `companion-state.json` for the companion to
//! read; this module writes the rare request in the other direction, which is
//! what lets a click on the companion ask a TUI window to open a session.
//!
//! Requests are still single-writer files: only this process creates them, and
//! a TUI window consumes one by an atomic rename, so a request is handled
//! exactly once even with several windows polling.
//!
//! Nothing here may touch `companion-state.json`. That file belongs to the
//! plugin, and keeping this process read-only against it is what lets the
//! original and Tauri implementations run side by side.

use std::io::Write;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::state::state_file_path;

/// Matches the plugin's `NavigateCommand`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NavigateRequest {
    pub version: u32,
    pub action: String,
    /// Named for JSON, where the plugin reads `sessionID`.
    #[serde(rename = "sessionID")]
    pub session_id: String,
    pub cwd: String,
    #[serde(rename = "requestedAt")]
    pub requested_at: u128,
}

impl NavigateRequest {
    /// The consumer discards a request older than its TTL, so the timestamp is
    /// what keeps a click from being answered much later by a window that
    /// happens to start afterwards.
    pub fn new(session_id: &str, cwd: &str, now_millis: u128) -> Self {
        Self {
            version: 1,
            action: "navigate".to_string(),
            session_id: session_id.to_string(),
            cwd: cwd.to_string(),
            requested_at: now_millis,
        }
    }
}

/// The request file, beside the plugin's state file.
pub fn command_file_path() -> std::path::PathBuf {
    state_file_path().with_file_name("companion-command.json")
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Writes `request` to `file` atomically.
///
/// A reader polling this path must never observe a partial write, so the body
/// goes to a sibling temp file and is renamed into place. `rename` is atomic
/// within a directory, which is what makes the swap invisible.
pub fn write_request(file: &Path, request: &NavigateRequest) -> std::io::Result<()> {
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let body = serde_json::to_string(request)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;

    let mut tmp_name = file.file_name().unwrap_or_default().to_os_string();
    tmp_name.push(format!(
        ".{}.{}.tmp",
        std::process::id(),
        request.requested_at
    ));
    let tmp = file.with_file_name(tmp_name);

    let write = || -> std::io::Result<()> {
        let mut handle = std::fs::File::create(&tmp)?;
        handle.write_all(body.as_bytes())?;
        handle.sync_all()
    };
    if let Err(err) = write() {
        let _ = std::fs::remove_file(&tmp);
        return Err(err);
    }

    if let Err(err) = std::fs::rename(&tmp, file) {
        let _ = std::fs::remove_file(&tmp);
        return Err(err);
    }
    Ok(())
}

/// Asks a TUI window to open `session_id` in `cwd`.
pub fn request_navigation(session_id: &str, cwd: &str) -> std::io::Result<()> {
    if session_id.trim().is_empty() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "cannot request navigation without a session id",
        ));
    }
    write_request(
        &command_file_path(),
        &NavigateRequest::new(session_id, cwd, now_millis()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("mechanicus-command-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    #[test]
    fn the_field_names_match_the_plugin_contract() {
        // The plugin reads these exact keys; renaming one silently breaks the
        // channel, so pin the wire shape rather than the Rust names.
        let request = NavigateRequest::new("sess-1", "/projects/alpha", 1_000_000);
        let json = serde_json::to_string(&request).expect("serialize");
        let value: serde_json::Value = serde_json::from_str(&json).expect("reparse");

        assert_eq!(value["version"], 1);
        assert_eq!(value["action"], "navigate");
        assert_eq!(value["sessionID"], "sess-1");
        assert_eq!(value["cwd"], "/projects/alpha");
        assert_eq!(value["requestedAt"], 1_000_000u64);
    }

    #[test]
    fn a_written_request_round_trips() {
        let dir = scratch("round-trip");
        let file = dir.join("companion-command.json");
        let request = NavigateRequest::new("sess-7", "/projects/beta", 42);

        write_request(&file, &request).expect("write");

        let raw = std::fs::read_to_string(&file).expect("read back");
        let parsed: NavigateRequest = serde_json::from_str(&raw).expect("parse");
        assert_eq!(parsed, request);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn writing_leaves_no_temp_file_behind() {
        let dir = scratch("no-litter");
        let file = dir.join("companion-command.json");

        write_request(&file, &NavigateRequest::new("s", "/p", 1)).expect("write");

        let names: Vec<String> = std::fs::read_dir(&dir)
            .expect("list")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["companion-command.json".to_string()]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rewriting_replaces_the_previous_request() {
        let dir = scratch("replace");
        let file = dir.join("companion-command.json");

        write_request(&file, &NavigateRequest::new("first", "/p", 1)).expect("first");
        write_request(&file, &NavigateRequest::new("second", "/p", 2)).expect("second");

        let raw = std::fs::read_to_string(&file).expect("read");
        let parsed: NavigateRequest = serde_json::from_str(&raw).expect("parse");
        assert_eq!(parsed.session_id, "second");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_empty_session_id_is_rejected_before_touching_disk() {
        let err = request_navigation("", "/projects/alpha").expect_err("must reject");
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidInput);

        let blank = request_navigation("   ", "/projects/alpha").expect_err("must reject");
        assert_eq!(blank.kind(), std::io::ErrorKind::InvalidInput);
    }

    #[test]
    fn the_request_file_sits_beside_the_state_file() {
        let command = command_file_path();
        let state = state_file_path();
        assert_eq!(command.parent(), state.parent());
        assert_eq!(
            command.file_name().and_then(|n| n.to_str()),
            Some("companion-command.json")
        );
    }
}

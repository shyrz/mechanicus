//! State contract shared with the mechanicus plugin.
//!
//! This mirrors `companion/src/state.rs` in the original Rust companion. The
//! plugin writes `companion-state.json`; this process only reads it. Keeping the
//! shape identical is what lets both implementations coexist behind
//! `companion.binaryPath`.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CompanionState {
    pub version: u32,
    #[serde(default)]
    pub sessions: Vec<SessionInfo>,
    #[serde(default)]
    pub config: Option<CompanionConfigState>,
    #[serde(default)]
    pub window_positions: BTreeMap<String, WindowPositionState>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct WindowPositionState {
    pub x: f32,
    pub y: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub session_id: String,
    pub cwd: String,
    #[serde(default)]
    pub active_agents: Vec<String>,
    #[serde(default)]
    pub active_agent: Option<String>,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub pid: Option<u32>,
    #[serde(default)]
    pub config: Option<CompanionConfigState>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompanionConfigState {
    pub enabled: bool,
    pub position: String,
    pub size: String,
    #[serde(default = "default_gif_pack", rename = "gifPack")]
    pub gif_pack: String,
    #[serde(default = "default_loop_style", rename = "loopStyle")]
    pub loop_style: String,
    #[serde(default = "default_speed")]
    pub speed: f32,
}

fn default_gif_pack() -> String {
    "default".to_string()
}

fn default_loop_style() -> String {
    "classic".to_string()
}

fn default_speed() -> f32 {
    1.0
}

/// Resolves the plugin's state file, honoring `XDG_DATA_HOME` like the plugin
/// and the original companion do.
pub fn state_file_path() -> PathBuf {
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
        .join("companion-state.json")
}

pub fn read_state(path: &std::path::Path) -> CompanionState {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Picks which session the overlay should display.
///
/// Ported from the original companion so both implementations show the same
/// session for the same state file. Priority: an explicitly owned session,
/// then the most recent session waiting on input, then the most recent with a
/// real (non-`intro`) agent, then the most recent busy session, then the last
/// session in the list.
pub fn choose_session(sessions: &[SessionInfo], owner_session_id: Option<&str>) -> Option<usize> {
    if let Some(owner) = owner_session_id {
        if let Some(index) = sessions
            .iter()
            .position(|session| session.session_id == owner)
        {
            return Some(index);
        }
    }

    sessions
        .iter()
        .enumerate()
        .rev()
        .find(|(_, s)| s.status == "waiting-input")
        .map(|(i, _)| i)
        .or_else(|| {
            sessions
                .iter()
                .enumerate()
                .rev()
                .find(|(_, s)| s.active_agents.iter().any(|agent| agent != "intro"))
                .map(|(i, _)| i)
        })
        .or_else(|| {
            sessions
                .iter()
                .enumerate()
                .rev()
                .find(|(_, s)| s.status == "busy")
                .map(|(i, _)| i)
        })
        .or_else(|| sessions.len().checked_sub(1))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(id: &str, status: &str, agents: &[&str]) -> SessionInfo {
        SessionInfo {
            session_id: id.to_string(),
            cwd: "/tmp/project".to_string(),
            active_agents: agents.iter().map(|a| a.to_string()).collect(),
            active_agent: None,
            status: status.to_string(),
            pid: None,
            config: None,
        }
    }

    #[test]
    fn owned_session_wins() {
        let sessions = vec![
            session("a", "busy", &["fixer"]),
            session("owner", "idle", &["intro"]),
        ];
        assert_eq!(choose_session(&sessions, Some("owner")), Some(1));
    }

    #[test]
    fn waiting_input_beats_other_sessions() {
        let sessions = vec![
            session("busy", "busy", &["fixer"]),
            session("waiting", "waiting-input", &["input"]),
        ];
        assert_eq!(choose_session(&sessions, None), Some(1));
    }

    #[test]
    fn real_agent_beats_idle_intro() {
        let sessions = vec![
            session("idle", "idle", &["intro"]),
            session("working", "idle", &["explorer"]),
        ];
        assert_eq!(choose_session(&sessions, None), Some(1));
    }

    #[test]
    fn falls_back_to_last_session() {
        let sessions = vec![session("a", "idle", &["intro"]), session("b", "idle", &[])];
        assert_eq!(choose_session(&sessions, None), Some(1));
        assert_eq!(choose_session(&[], None), None);
    }

    #[test]
    fn unknown_owner_falls_back_to_heuristics() {
        let sessions = vec![session("a", "idle", &["intro"])];
        assert_eq!(choose_session(&sessions, Some("missing")), Some(0));
    }
}

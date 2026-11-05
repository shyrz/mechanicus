//! Per-project placement owned by the Tauri companion, separate from plugin state.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::snap::SnapTarget;
use crate::state::CompanionState;
use crate::workarea::Rect;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct WindowPlacement {
    pub x: f64,
    pub y: f64,
    #[serde(default)]
    pub target: Option<SnapTarget>,
}

pub enum FloatingPosition {
    Corner(String),
    Custom { x: f64, y: f64 },
}

pub fn project_key(cwd: &str) -> String {
    Path::new(cwd)
        .canonicalize()
        .ok()
        .and_then(|path| path.into_os_string().into_string().ok())
        .unwrap_or_else(|| cwd.to_string())
}

pub fn file_path() -> PathBuf {
    crate::state::state_file_path().with_file_name("companion-tauri-positions.json")
}

pub fn legacy_position(state: &CompanionState, project: &str) -> Option<WindowPlacement> {
    let project = project_key(project);
    state.window_positions.iter().find_map(|(key, position)| {
        (project_key(key) == project).then_some(WindowPlacement {
            x: position.x as f64,
            y: position.y as f64,
            target: None,
        })
    })
}

fn read(file: &Path) -> io::Result<BTreeMap<String, WindowPlacement>> {
    match std::fs::read(file) {
        Ok(raw) => serde_json::from_slice(&raw).map_err(io::Error::other),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(error) => Err(error),
    }
}

pub fn load(file: &Path, project: &str) -> io::Result<Option<WindowPlacement>> {
    Ok(read(file)?.get(&project_key(project)).copied())
}

pub fn save(file: &Path, project: &str, placement: WindowPlacement) -> io::Result<()> {
    if project.trim().is_empty() || !placement.x.is_finite() || !placement.y.is_finite() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid window placement",
        ));
    }
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let _lock = WriteLock::acquire(file)?;
    let mut positions = read(file)?;
    positions.insert(project_key(project), placement);
    let tmp = file.with_extension(format!("{}.tmp", std::process::id()));
    let result = (|| {
        let json = serde_json::to_vec(&positions).map_err(io::Error::other)?;
        std::fs::write(&tmp, json)?;
        std::fs::rename(&tmp, file)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

enum WriteRequest {
    Save(WindowPlacement),
    Flush(std::sync::mpsc::SyncSender<()>),
}

pub struct PlacementWriter {
    sender: std::sync::mpsc::Sender<WriteRequest>,
}

impl PlacementWriter {
    pub fn new(file: PathBuf, project: String) -> Self {
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            while let Ok(request) = receiver.recv() {
                match request {
                    WriteRequest::Save(placement) => {
                        if let Err(error) = save(&file, &project, placement) {
                            eprintln!("[companion-tauri] could not save window placement: {error}");
                        }
                    }
                    WriteRequest::Flush(done) => {
                        let _ = done.send(());
                    }
                }
            }
        });
        Self { sender }
    }

    pub fn submit(&self, placement: WindowPlacement) {
        if self.sender.send(WriteRequest::Save(placement)).is_err() {
            eprintln!("[companion-tauri] window placement writer stopped");
        }
    }

    pub fn flush(&self) -> io::Result<()> {
        let (done, receiver) = std::sync::mpsc::sync_channel(0);
        self.sender
            .send(WriteRequest::Flush(done))
            .map_err(io::Error::other)?;
        receiver
            .recv_timeout(Duration::from_secs(2))
            .map_err(io::Error::other)
    }
}

#[cfg(unix)]
struct WriteLock {
    // Closing the descriptor releases flock, including on process termination.
    // The lock file stays in place so every writer locks the same inode.
    _file: std::fs::File,
}

#[cfg(unix)]
impl WriteLock {
    fn acquire(file: &Path) -> io::Result<Self> {
        use std::os::fd::AsRawFd;
        extern "C" {
            fn flock(fd: i32, operation: i32) -> i32;
        }
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(file.with_extension("json.lock"))?;
        for _ in 0..40 {
            // SAFETY: the descriptor belongs to this live File; LOCK_EX |
            // LOCK_NB is nonblocking. Closing it also releases a crashed writer's lock.
            if unsafe { flock(file.as_raw_fd(), 2 | 4) } == 0 {
                return Ok(Self { _file: file });
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::WouldBlock {
                return Err(error);
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        Err(io::Error::new(
            io::ErrorKind::WouldBlock,
            "window placement lock timed out",
        ))
    }
}

#[cfg(not(unix))]
struct WriteLock(PathBuf);

#[cfg(not(unix))]
impl WriteLock {
    fn acquire(file: &Path) -> io::Result<Self> {
        let lock = file.with_extension("json.lock");
        for _ in 0..40 {
            match std::fs::create_dir(&lock) {
                Ok(()) => return Ok(Self(lock)),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    std::thread::sleep(Duration::from_millis(25));
                }
                Err(error) => return Err(error),
            }
        }
        Err(io::Error::new(
            io::ErrorKind::WouldBlock,
            "window placement lock timed out",
        ))
    }
}

#[cfg(not(unix))]
impl Drop for WriteLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir(&self.0);
    }
}

pub fn floating_rect(position: &FloatingPosition, content: (f64, f64), work: Rect) -> Rect {
    let (w, h) = content;
    let max_x = (work.x + work.w - w).max(work.x);
    let max_y = (work.y + work.h - h).max(work.y);
    let (x, y) = match position {
        FloatingPosition::Custom { x, y } => (*x, *y),
        FloatingPosition::Corner(corner) => {
            let left = (work.x + 10.0).min(max_x);
            let top = (work.y + 10.0).min(max_y);
            let right = (max_x - 10.0).max(work.x);
            let bottom = (max_y - 10.0).max(work.y);
            match corner.as_str() {
                "top-left" => (left, top),
                "top-right" => (right, top),
                "bottom-left" => (left, bottom),
                _ => (right, bottom),
            }
        }
    };
    Rect {
        x: x.clamp(work.x, max_x),
        y: y.clamp(work.y, max_y),
        w,
        h,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::WindowPositionState;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Scratch(std::path::PathBuf);

    impl Scratch {
        fn new() -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let path = std::env::temp_dir().join(format!(
                "companion-placement-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn file(&self) -> std::path::PathBuf {
            self.0.join("positions.json")
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }

    const WORK: Rect = Rect {
        x: 0.0,
        y: 25.0,
        w: 1920.0,
        h: 985.0,
    };
    const FLOATING: WindowPlacement = WindowPlacement {
        x: 300.0,
        y: 400.0,
        target: None,
    };

    #[test]
    fn dragged_position_survives_a_fresh_read() {
        let scratch = Scratch::new();
        save(&scratch.file(), "/project", FLOATING).unwrap();
        assert_eq!(load(&scratch.file(), "/project").unwrap(), Some(FLOATING));
    }

    #[test]
    fn a_later_drop_replaces_the_previous_position() {
        let scratch = Scratch::new();
        save(&scratch.file(), "/project", FLOATING).unwrap();
        let later = WindowPlacement {
            x: 700.0,
            y: 600.0,
            target: None,
        };
        save(&scratch.file(), "/project", later).unwrap();
        assert_eq!(load(&scratch.file(), "/project").unwrap(), Some(later));
    }

    #[test]
    fn snap_target_survives_a_fresh_read() {
        let scratch = Scratch::new();
        let docked = WindowPlacement {
            x: -48.0,
            y: 450.0,
            target: Some(SnapTarget::Right),
        };
        save(&scratch.file(), "/project", docked).unwrap();
        assert_eq!(load(&scratch.file(), "/project").unwrap(), Some(docked));
    }

    #[test]
    fn same_named_projects_keep_independent_positions() {
        let scratch = Scratch::new();
        save(&scratch.file(), "/a/demo", FLOATING).unwrap();
        let other = WindowPlacement {
            x: 900.0,
            y: 700.0,
            target: None,
        };
        save(&scratch.file(), "/z/demo", other).unwrap();
        assert_eq!(load(&scratch.file(), "/a/demo").unwrap(), Some(FLOATING));
        assert_eq!(load(&scratch.file(), "/z/demo").unwrap(), Some(other));
        assert_eq!(load(&scratch.file(), "/missing/demo").unwrap(), None);
    }

    #[test]
    fn concurrent_saves_do_not_drop_other_projects() {
        let scratch = Scratch::new();
        std::thread::scope(|scope| {
            for n in 0..8 {
                let file = scratch.file();
                scope.spawn(move || save(&file, &format!("/project-{n}"), FLOATING).unwrap());
            }
        });
        for n in 0..8 {
            assert_eq!(
                load(&scratch.file(), &format!("/project-{n}")).unwrap(),
                Some(FLOATING)
            );
        }
    }

    #[test]
    fn corrupt_storage_is_reported_and_preserved() {
        let scratch = Scratch::new();
        std::fs::write(scratch.file(), b"{broken").unwrap();
        assert!(load(&scratch.file(), "/project").is_err());
        assert!(save(&scratch.file(), "/project", FLOATING).is_err());
        assert_eq!(std::fs::read(scratch.file()).unwrap(), b"{broken");
    }

    #[test]
    fn invalid_coordinates_are_not_saved() {
        let scratch = Scratch::new();
        let invalid = WindowPlacement {
            x: f64::NAN,
            ..FLOATING
        };
        assert!(save(&scratch.file(), "/project", invalid).is_err());
        assert!(save(&scratch.file(), "", FLOATING).is_err());
        assert!(!scratch.file().exists());
    }

    #[test]
    fn subprocess_lock_holder() {
        let Some(file) = std::env::var_os("COMPANION_PLACEMENT_LOCK_TEST") else {
            return;
        };
        let file = PathBuf::from(file);
        let _lock = WriteLock::acquire(&file).unwrap();
        std::fs::write(file.with_extension("ready"), b"ready").unwrap();
        loop {
            std::thread::park();
        }
    }

    #[test]
    fn a_killed_writer_does_not_prevent_future_saves() {
        let scratch = Scratch::new();
        let file = scratch.file();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "placement::tests::subprocess_lock_holder"])
            .env("COMPANION_PLACEMENT_LOCK_TEST", &file)
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        for _ in 0..100 {
            if file.with_extension("ready").exists() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(
            file.with_extension("ready").exists(),
            "child did not acquire the lock"
        );
        save(&file, "/project", FLOATING).unwrap();
        assert_eq!(load(&file, "/project").unwrap(), Some(FLOATING));
    }

    #[test]
    fn exit_flush_waits_for_the_final_queued_save() {
        let scratch = Scratch::new();
        let file = scratch.file();
        let lock = WriteLock::acquire(&file).unwrap();
        let writer = PlacementWriter::new(file.clone(), "/project".into());
        writer.submit(FLOATING);
        let later = WindowPlacement {
            x: 800.0,
            y: 700.0,
            target: None,
        };
        writer.submit(later);
        let release = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            drop(lock);
        });
        writer.flush().unwrap();
        assert_eq!(load(&file, "/project").unwrap(), Some(later));
        release.join().unwrap();
    }

    #[test]
    fn legacy_lookup_uses_the_complete_project_path() {
        let mut state = CompanionState::default();
        state
            .window_positions
            .insert("/a/demo".into(), WindowPositionState { x: 100.0, y: 200.0 });
        state
            .window_positions
            .insert("/z/demo".into(), WindowPositionState { x: 900.0, y: 700.0 });
        assert_eq!(
            legacy_position(&state, "/z/demo"),
            Some(WindowPlacement {
                x: 900.0,
                y: 700.0,
                target: None
            })
        );
        assert_eq!(legacy_position(&state, "/missing/demo"), None);
    }

    #[test]
    fn project_keys_resolve_equivalent_paths() {
        let scratch = Scratch::new();
        let cwd = scratch.0.to_str().unwrap();
        assert_eq!(
            project_key(&format!(
                "{cwd}/../{}",
                scratch.0.file_name().unwrap().to_str().unwrap()
            )),
            project_key(cwd)
        );
    }

    #[test]
    fn default_corner_keeps_its_margins_when_the_grid_grows() {
        let position = FloatingPosition::Corner("bottom-right".into());
        assert_eq!(
            floating_rect(&position, (48.0, 48.0), WORK),
            Rect {
                x: 1862.0,
                y: 952.0,
                w: 48.0,
                h: 48.0
            }
        );
        assert_eq!(
            floating_rect(&position, (90.0, 90.0), WORK),
            Rect {
                x: 1820.0,
                y: 910.0,
                w: 90.0,
                h: 90.0
            }
        );
    }

    #[test]
    fn custom_origin_stays_fixed_when_the_grid_changes() {
        let position = FloatingPosition::Custom { x: 300.0, y: 400.0 };
        assert_eq!(
            floating_rect(&position, (48.0, 48.0), WORK),
            Rect {
                x: 300.0,
                y: 400.0,
                w: 48.0,
                h: 48.0
            }
        );
        assert_eq!(
            floating_rect(&position, (90.0, 90.0), WORK),
            Rect {
                x: 300.0,
                y: 400.0,
                w: 90.0,
                h: 90.0
            }
        );
    }

    #[test]
    fn saved_coordinates_are_clamped_inside_the_work_area() {
        let position = FloatingPosition::Custom {
            x: 5000.0,
            y: 3000.0,
        };
        assert_eq!(
            floating_rect(&position, (48.0, 48.0), WORK),
            Rect {
                x: 1872.0,
                y: 962.0,
                w: 48.0,
                h: 48.0
            }
        );
    }

    #[test]
    fn negative_monitor_origins_are_preserved() {
        let work = Rect {
            x: -1280.0,
            y: 25.0,
            w: 1280.0,
            h: 775.0,
        };
        let corner = FloatingPosition::Corner("bottom-right".into());
        assert_eq!(
            floating_rect(&corner, (48.0, 48.0), work),
            Rect {
                x: -58.0,
                y: 742.0,
                w: 48.0,
                h: 48.0
            }
        );
        let custom = FloatingPosition::Custom {
            x: -900.0,
            y: 200.0,
        };
        assert_eq!(
            floating_rect(&custom, (48.0, 48.0), work),
            Rect {
                x: -900.0,
                y: 200.0,
                w: 48.0,
                h: 48.0
            }
        );
    }
}

use std::sync::Mutex;
use tauri::{Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::workarea::Rect;

const WINDOW: &str = "project-tooltip";
const CONTENT_EVENT: &str = "companion://tooltip-content";
const SCREEN_MARGIN: f64 = 4.0;
const ICON_GAP: f64 = 2.0;
const TAIL_HEIGHT: f64 = 7.0;

#[derive(Clone, serde::Deserialize)]
pub struct TooltipRequest {
    project: String,
    anchor: [f64; 4],
}

#[derive(Clone, serde::Serialize)]
struct TooltipContent {
    generation: u64,
    project: String,
}

struct Pending {
    content: TooltipContent,
    anchor: Rect,
}

#[derive(Default)]
struct Inner {
    generation: u64,
    ready: bool,
    pending: Option<Pending>,
}

#[derive(Default)]
pub struct TooltipState(Mutex<Inner>);

#[derive(serde::Serialize)]
pub struct Placement {
    above: bool,
    tail_x: f64,
    max_width: Option<f64>,
}

fn place(anchor: Rect, size: (f64, f64), work: Rect) -> (Rect, Placement) {
    let (width, height) = size;
    let center_x = anchor.x + anchor.w / 2.0;
    let min_x = work.x + SCREEN_MARGIN;
    let max_x = (work.x + work.w - SCREEN_MARGIN - width).max(min_x);
    let x = (center_x - width / 2.0).clamp(min_x, max_x);

    let below = anchor.y + anchor.h + ICON_GAP;
    let above = below + height > work.y + work.h - SCREEN_MARGIN;
    let y = if above {
        (anchor.y - ICON_GAP - height).max(work.y + SCREEN_MARGIN)
    } else {
        below
    };

    (
        Rect {
            x,
            y,
            w: width,
            h: height,
        },
        Placement {
            above,
            tail_x: (center_x - x).clamp(8.0, (width - 8.0).max(8.0)),
            max_width: None,
        },
    )
}

pub fn build(app: &tauri::App) -> tauri::Result<()> {
    let window = WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::App("tooltip.html".into()))
        .title("project name")
        .inner_size(240.0, 256.0)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .focused(false)
        .focusable(false)
        .resizable(false)
        .visible(false)
        .build()?;
    window.set_ignore_cursor_events(true)?;
    Ok(())
}

#[tauri::command]
pub fn set_project_tooltip(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, TooltipState>,
    request: Option<TooltipRequest>,
) -> Result<(), String> {
    let tooltip = app
        .get_webview_window(WINDOW)
        .ok_or("tooltip unavailable")?;
    let mut inner = state.0.lock().map_err(|e| e.to_string())?;
    inner.generation = inner.generation.wrapping_add(1);

    let Some(request) = request else {
        inner.pending = None;
        return tooltip.hide().map_err(|e| e.to_string());
    };
    if request.project.is_empty()
        || request.anchor.iter().any(|value| !value.is_finite())
        || request.anchor[2] <= 0.0
        || request.anchor[3] <= 0.0
    {
        inner.pending = None;
        let _ = tooltip.hide();
        return Err("invalid tooltip request".to_string());
    }

    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let origin = window
        .outer_position()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(scale);
    let content = TooltipContent {
        generation: inner.generation,
        project: request.project,
    };
    inner.pending = Some(Pending {
        content: content.clone(),
        anchor: Rect {
            x: origin.x + request.anchor[0],
            y: origin.y + request.anchor[1],
            w: request.anchor[2],
            h: request.anchor[3],
        },
    });
    if inner.ready {
        tooltip
            .emit(CONTENT_EVENT, content)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn project_tooltip_ready(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, TooltipState>,
) -> Result<(), String> {
    if window.label() != WINDOW {
        return Err("tooltip command requires the tooltip window".to_string());
    }
    let mut inner = state.0.lock().map_err(|e| e.to_string())?;
    inner.ready = true;
    if let Some(pending) = &inner.pending {
        window
            .emit(CONTENT_EVENT, pending.content.clone())
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn measure_project_tooltip(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, TooltipState>,
    snap: tauri::State<'_, std::sync::Arc<crate::snap::SnapController>>,
    generation: u64,
    width: f64,
    height: f64,
) -> Result<Option<Placement>, String> {
    if window.label() != WINDOW {
        return Err("tooltip command requires the tooltip window".to_string());
    }
    if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
        return Err("invalid tooltip size".to_string());
    }
    let inner = state.0.lock().map_err(|e| e.to_string())?;
    let Some(pending) = inner
        .pending
        .as_ref()
        .filter(|p| p.content.generation == generation)
    else {
        return Ok(None);
    };
    let anchor = pending.anchor;
    let screen = crate::workarea::screen_at((anchor.x + anchor.w / 2.0, anchor.y))
        .or_else(|| snap.screen())
        .ok_or("screen geometry unavailable")?;
    let max_width = (screen.work.w - SCREEN_MARGIN * 2.0).floor();
    if width > max_width && max_width >= 16.0 {
        return Ok(Some(Placement {
            above: false,
            tail_x: 0.0,
            max_width: Some(max_width),
        }));
    }
    let (rect, placement) = place(anchor, (width, height + TAIL_HEIGHT), screen.work);
    window
        .set_size(LogicalSize::new(rect.w, rect.h))
        .and_then(|_| window.set_position(LogicalPosition::new(rect.x, rect.y)))
        .map_err(|e| e.to_string())?;
    Ok(Some(placement))
}

#[tauri::command]
pub fn show_project_tooltip(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, TooltipState>,
    generation: u64,
) -> Result<(), String> {
    if window.label() != WINDOW {
        return Err("tooltip command requires the tooltip window".to_string());
    }
    let inner = state.0.lock().map_err(|e| e.to_string())?;
    if inner
        .pending
        .as_ref()
        .is_some_and(|pending| pending.content.generation == generation)
    {
        window.show().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORK: Rect = Rect {
        x: 0.0,
        y: 20.0,
        w: 1000.0,
        h: 700.0,
    };

    #[test]
    fn stays_below_the_icon_when_there_is_room() {
        let anchor = Rect {
            x: 400.0,
            y: 100.0,
            w: 44.0,
            h: 44.0,
        };
        let (rect, placement) = place(anchor, (220.0, 60.0), WORK);
        assert_eq!(rect.x, 312.0);
        assert_eq!(rect.y, 146.0);
        assert!(!placement.above);
        assert_eq!(placement.tail_x, 110.0);
    }

    #[test]
    fn keeps_the_bubble_and_tail_visible_at_the_screen_edge() {
        let anchor = Rect {
            x: 0.0,
            y: 100.0,
            w: 44.0,
            h: 44.0,
        };
        let (rect, placement) = place(anchor, (220.0, 60.0), WORK);
        assert_eq!(rect.x, 4.0);
        assert_eq!(placement.tail_x, 18.0);
    }

    #[test]
    fn flips_above_an_icon_near_the_bottom_edge() {
        let anchor = Rect {
            x: 900.0,
            y: 660.0,
            w: 44.0,
            h: 44.0,
        };
        let (rect, placement) = place(anchor, (220.0, 60.0), WORK);
        assert_eq!(rect.x, 776.0);
        assert_eq!(rect.y, 598.0);
        assert!(placement.above);
        assert_eq!(placement.tail_x, 146.0);
    }
}

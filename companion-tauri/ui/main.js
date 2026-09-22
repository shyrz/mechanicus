/**
 * Companion overlay renderer.
 *
 * Animation math is a direct port of `companion/src/gifs.rs` so both
 * implementations show the same frame of the same sheet at the same instant.
 *
 * Geometry, by contrast, is owned by Rust: the snap state machine emits the
 * content rect every frame and this file only applies it, which keeps the
 * visible content and the click-through region in step.
 */

// ── Sprite sheet constants (mirror gifs.rs) ────────────────────────────────
const FRAME_RATE = 24;
const FRAME_COUNT = 72;
const SHEET_COLS = 12;
const SHEET_ROWS = 6;

/** agent name → bundled sheet, mirroring `Gifs::new` + `resolve_name`. */
const SHEETS = {
  council: 'council.jpg',
  councillor: 'council.jpg',
  designer: 'designer.jpg',
  explorer: 'explorer.jpg',
  fixer: 'fixer.jpg',
  input: 'question.jpg',
  intro: 'intro.jpg',
  librarian: 'librarian.jpg',
  observer: 'observer.jpg',
  oracle: 'oracle.jpg',
  orchestrator: 'orchestrator.jpg',
  unknown: 'unknown.jpg',
};

function resolveSheet(agent) {
  // Dynamic councillors share the council animation (gifs.rs `resolve_name`).
  if (agent.startsWith('councillor-')) return SHEETS.council;
  return SHEETS[agent] ?? SHEETS.unknown;
}

function normalizedSpeed(speed) {
  if (!Number.isFinite(speed)) return 1;
  return Math.min(4, Math.max(0.25, speed));
}

/** Ported verbatim from `gifs.rs::frame_index`. */
function frameIndex(timeSeconds, speed, loopStyle) {
  const effective = normalizedSpeed(speed);
  const tick = Math.floor(Math.max(0, timeSeconds) * FRAME_RATE * effective);
  if (loopStyle === 'smooth') {
    const period = FRAME_COUNT * 2 - 2;
    const phase = tick % period;
    return phase < FRAME_COUNT ? phase : period - phase;
  }
  return tick % FRAME_COUNT;
}

/** Ported from `gifs.rs::frame_uv` — grid cell for a frame index. */
function frameCell(index) {
  return { col: index % SHEET_COLS, row: Math.floor(index / SHEET_COLS) };
}

/** Status colour, shared by the expanded ring and the collapsed handle. */
const STATUS_COLORS = {
  'waiting-input': 'rgba(255, 176, 32, 0.95)',
  busy: 'rgba(64, 200, 120, 0.85)',
  idle: 'rgba(120, 120, 128, 0.75)',
};

// ── Elements ───────────────────────────────────────────────────────────────
const root = document.documentElement;
const content = document.getElementById('content');
const grid = document.getElementById('grid');
const label = document.getElementById('label');

/** @type {{ el: HTMLElement, lastFrame: number }[]} */
let tiles = [];
let payload = null;

// ── Rendering ──────────────────────────────────────────────────────────────
function render(p) {
  payload = p;

  grid.style.gridTemplateColumns = `repeat(${p.cols}, 1fr)`;
  grid.style.gridTemplateRows = `repeat(${p.rows}, 1fr)`;

  const agents = p.session?.agents?.length ? p.session.agents : ['intro'];

  // Rebuild only when the agent set or cell size changed.
  const signature = `${agents.join('|')}:${p.cell}`;
  if (grid.dataset.signature !== signature) {
    grid.dataset.signature = signature;
    grid.innerHTML = '';
    tiles = agents.map((agent) => {
      const el = document.createElement('div');
      el.className = 'tile';
      el.style.backgroundImage = `url("assets/${resolveSheet(agent)}")`;
      el.style.backgroundSize = `${SHEET_COLS * p.cell}px ${SHEET_ROWS * p.cell}px`;
      el.title = agent;
      grid.appendChild(el);
      return { el, lastFrame: -1 };
    });
  }

  const status = p.session?.status ?? 'idle';
  for (const tile of tiles) {
    tile.el.className = `tile state-${status}`;
  }

  // The collapsed handle has no animation to read, so colour is the only cue.
  root.style.setProperty(
    '--status-color',
    STATUS_COLORS[status] ?? STATUS_COLORS.idle,
  );

  label.textContent = p.session ? `${p.session.project} · ${status}` : '';
  document.title = p.session?.project ?? 'mechanicus-companion';
}

/** Corner radius, driven by how collapsed the overlay is. */
function radiusFor(target, progress) {
  const r = (11 * progress).toFixed(1);
  switch (target) {
    case 'right':
      return `${r}px 0 0 ${r}px`;
    case 'left':
      return `0 ${r}px ${r}px 0`;
    case 'bottom':
      return `${r}px ${r}px 0 0`;
    default:
      return '0';
  }
}

function applySnap(s) {
  const [x, y, w, h] = s.content;
  root.style.setProperty('--content-x', `${x}px`);
  root.style.setProperty('--content-y', `${y}px`);
  root.style.setProperty('--content-w', `${w}px`);
  root.style.setProperty('--content-h', `${h}px`);

  const progress = s.snapped ? s.progress : 0;
  root.style.setProperty('--radius', radiusFor(s.target, progress));
  // Tiles give way to the handle as the overlay collapses.
  root.style.setProperty('--tiles-opacity', String(1 - progress));
  root.style.setProperty('--handle-opacity', String(progress));

  content.className = `content${s.target ? ` target-${s.target}` : ''}${progress > 0.5 ? ' collapsed' : ''}`;
}

function tick(now) {
  if (payload) {
    const seconds = now / 1000;
    for (const tile of tiles) {
      const index = frameIndex(
        seconds,
        payload.config.speed,
        payload.config.loop_style,
      );
      if (index === tile.lastFrame) continue;
      tile.lastFrame = index;
      const { col, row } = frameCell(index);
      // Frames are drawn at the sheet's own cell size and scaled to fit.
      const cell = payload.cell;
      tile.el.style.backgroundPosition = `${-col * cell}px ${-row * cell}px`;
    }
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ── Interaction ────────────────────────────────────────────────────────────
const DRAG_THRESHOLD_PX = 4;
const appWindow = window.__TAURI__?.window?.getCurrentWindow?.();
const core = window.__TAURI__?.core;

let pressOrigin = null;
let dragging = false;

content.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  pressOrigin = { x: event.clientX, y: event.clientY };
  dragging = false;
});

content.addEventListener('pointermove', async (event) => {
  if (!pressOrigin || dragging) return;
  const dx = event.clientX - pressOrigin.x;
  const dy = event.clientY - pressOrigin.y;
  if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
  dragging = true;
  try {
    // Tell Rust a drag is in flight so the snap loop leaves the window alone.
    await core?.invoke('set_dragging', { dragging: true });
    // Hand the drag to the compositor. This only posts a request to the main
    // thread and returns immediately — it does not wait for the drag to finish —
    // so nothing here may report a release. The nested drag loop swallows the
    // mouse events too, which is why this webview never sees a `pointerup` for
    // the drag either; Rust detects the release from the physical button instead.
    await appWindow?.startDragging?.();
  } catch (err) {
    console.error('[companion] drag failed', err);
  } finally {
    pressOrigin = null;
    dragging = false;
  }
});

content.addEventListener('pointerup', async (event) => {
  const wasDragging = dragging;
  pressOrigin = null;
  dragging = false;
  if (wasDragging || event.button !== 0) return;

  // Reveal the session being shown, as far as the host allows: a TUI opens it
  // (through a request file the plugin polls), while a desktop host can only be
  // raised. Rust picks between the two from the host the plugin publishes.
  const session = payload?.session;
  if (!session?.session_id) return;
  try {
    await window.__TAURI__?.core?.invoke('reveal_session', {
      sessionId: session.session_id,
      cwd: session.cwd,
    });
  } catch (err) {
    console.error('[companion] reveal failed', err);
  }
});

content.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  console.log(
    '[companion] context menu',
    payload?.session?.session_id ?? 'none',
  );
});

// ── Debug keys (testing only) ──────────────────────────────────────────────
let snapEnabled = true;
let forceIgnore = false;

window.addEventListener('keydown', (event) => {
  if (event.key === 's') {
    snapEnabled = !snapEnabled;
    core?.invoke('set_snap_enabled', { enabled: snapEnabled }).catch(() => {});
    console.log('[companion] edge snapping', snapEnabled);
  }
  if (event.key === 't') {
    forceIgnore = !forceIgnore;
    core?.invoke('set_click_through', { ignore: forceIgnore }).catch(() => {});
    console.log('[companion] forced click-through', forceIgnore);
  }
});

// ── State wiring ───────────────────────────────────────────────────────────
(async () => {
  const api = window.__TAURI__;
  if (!api) {
    console.error(
      '[companion] Tauri API unavailable; rendering static fallback',
    );
    render({
      session: {
        session_id: 'preview',
        cwd: '',
        project: 'preview',
        status: 'busy',
        agents: ['orchestrator'],
      },
      config: {
        position: 'bottom-right',
        size: 'medium',
        speed: 1,
        loop_style: 'classic',
      },
      cell: 120,
      cols: 1,
      rows: 1,
    });
    return;
  }

  await api.event.listen('companion://state', (event) => render(event.payload));
  await api.event.listen('companion://snap', (event) =>
    applySnap(event.payload),
  );

  try {
    render(await api.core.invoke('get_state'));
  } catch (err) {
    console.error('[companion] initial state failed', err);
  }
})();

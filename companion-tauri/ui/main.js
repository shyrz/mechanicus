/**
 * Companion overlay renderer.
 *
 * One circular button per running agent, each carrying the icon for that
 * agent's role (see `icons.js`). The buttons are the companion: there is no
 * sprite animation, because the UI is meant to communicate *which* agents are
 * running at a glance rather than to mirror the reference app's artwork.
 *
 * Geometry is owned by Rust: the snap state machine emits the content rect
 * every frame and this file only applies it, which keeps the visible content and
 * the click-through region in step.
 */

// ── Elements ───────────────────────────────────────────────────────────────
const root = document.documentElement;
const content = document.getElementById('content');
const grid = document.getElementById('grid');
const label = document.getElementById('label');

/** @type {{ el: HTMLElement, agent: string }[]} */
let tiles = [];
let payload = null;
/** Window-local pointer position in logical px, or null when it is outside. */
let cursorAt = null;

/** Whether `el` is under the pointer, measured rather than derived. */
function cursorOver(el) {
  if (!cursorAt) return false;
  const box = el.getBoundingClientRect();
  return (
    cursorAt.x >= box.left &&
    cursorAt.x <= box.right &&
    cursorAt.y >= box.top &&
    cursorAt.y <= box.bottom
  );
}

/**
 * Paints the button under the pointer from the position Rust publishes.
 *
 * CSS `:hover` needs the webview to receive mouse-moved events, which this overlay
 * cannot count on: it is an accessory window and never becomes the key window, and
 * WebKit scopes hover tracking to that. The cursor the poll already reads is what
 * opens the window, so it drives the same rule; both selectors are in one place in
 * the stylesheet, so whichever arrives first wins and they cannot disagree.
 */
function paintHover() {
  for (const tile of tiles) {
    tile.el.classList.toggle('cursor-over', cursorOver(tile.el));
  }
  // Collapsed, the window is the handle, so anywhere inside it is over the pill.
  content.classList.toggle('cursor-over', cursorAt !== null);
}

// ── Rendering ──────────────────────────────────────────────────────────────
function render(p) {
  payload = p;

  // Grid shape is handed to the stylesheet as counts: the track definition
  // itself lives in CSS, so its `auto` sizing cannot be lost here. Rust chooses
  // the shape from the docked edge, so a side dock arrives as a column and the
  // bottom dock as a row.
  grid.style.setProperty('--cols', String(p.cols));
  grid.style.setProperty('--rows', String(p.rows));
  // The button is a fixed disc; the window was sized from it in Rust.
  root.style.setProperty('--button-size', `${p.button}px`);

  const agents = p.session?.agents?.length ? p.session.agents : ['intro'];

  // Rebuild only when the agent set or button size changed: rebuilding every
  // poll would restart each button's hover transition.
  const signature = `${agents.join('|')}:${p.button}`;
  if (grid.dataset.signature !== signature) {
    grid.dataset.signature = signature;
    grid.innerHTML = '';
    tiles = agents.map((agent) => {
      const el = document.createElement('div');
      el.className = 'tile';
      el.title = agent;
      // Inline SVG, so the button's colour drives the icon via currentColor.
      el.innerHTML = window.agentIcon(agent);
      grid.appendChild(el);
      return { el, agent };
    });
  }

  const status = p.session?.status ?? 'idle';
  for (const tile of tiles) {
    tile.el.className = `tile state-${status}`;
  }

  // The status name is all that crosses this boundary: the stylesheet owns what
  // each status looks like, and it is the same colour for the buttons' rings and
  // the collapsed handle's bar. On `dataset`, because `content.className` is
  // rewritten on every snap payload.
  content.dataset.status = status;
  label.textContent = p.session ? `${p.session.project} · ${status}` : '';
  // Rust decides whether a caption fits inside the footprint (a side dock is too
  // narrow for one); this renders that decision instead of repeating it.
  label.classList.toggle('is-hidden', p.caption === false);
  // After the class lists above, which would otherwise drop this.
  paintHover();

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

  cursorAt = s.cursor ? { x: s.cursor[0], y: s.cursor[1] } : null;

  // Derived from `progress`, not from the payload's `expanded`: the fade is driven
  // by `progress`, and the two can sit far apart (Rust's hover flag versus where the
  // animation actually is), in which case the label and the handle showed at once.
  content.className = `content${s.target ? ` target-${s.target}` : ''}${progress > 0.5 ? ' collapsed' : ''}`;
  // `content.className` was just rebuilt, so the hover class is reapplied here.
  paintHover();
}

// ── Interaction ────────────────────────────────────────────────────────────
const DRAG_THRESHOLD_PX = 4;
const appWindow = window.__TAURI__?.window?.getCurrentWindow?.();
const core = window.__TAURI__?.core;

let pressOrigin = null;
/**
 * True once this press has been handed to the compositor as a drag.
 *
 * Deliberately sticky for the whole press. `startDragging` returns as soon as the
 * request is posted and the drag itself runs outside this webview, so no event
 * marks its end. Clearing this flag when the request returns — in a `finally`, as
 * this used to — destroys the only record that the gesture was a drag, and the
 * release the compositor does deliver afterwards is then read as a click, which
 * is how dragging ended up revealing the session.
 *
 * Only `pointerdown` clears it. A compositor drag can deliver more than one
 * release, and the start of the next press is the only boundary that is reliably
 * observed, so the gesture state is reset there rather than on release.
 */
let pressWasDrag = false;
/** True while a drag request is outstanding; stops every later move re-posting it. */
let dragRequested = false;

content.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  pressOrigin = { x: event.clientX, y: event.clientY };
  pressWasDrag = false;
  dragRequested = false;
});

content.addEventListener('pointermove', async (event) => {
  // A release that lands outside `#content` never reaches the handler below: once
  // docked, the content is smaller than the window, so letting go over the padding
  // or the shadow delivers the release to `body`. The press would stay recorded
  // with no button held, and the next hover move -- already past the threshold --
  // would post a drag for a press that ended long ago. A move is the first thing a
  // hover produces, so it is where this is caught.
  if (event.buttons === 0) {
    pressOrigin = null;
    return;
  }
  if (!pressOrigin || dragRequested) return;
  const dx = event.clientX - pressOrigin.x;
  const dy = event.clientY - pressOrigin.y;
  if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
  // Recorded before the await: past the threshold this gesture is a drag whatever
  // becomes of the request.
  pressWasDrag = true;
  dragRequested = true;
  // Rust stops publishing the cursor while a drag is in flight, so without this the
  // last highlight stays painted for the whole drag.
  cursorAt = null;
  paintHover();
  try {
    // Tell Rust a drag is in flight so the snap loop leaves the window alone.
    await core?.invoke('set_dragging', { dragging: true });
    // Hand the drag to the compositor. This only posts a request to the main
    // thread and returns immediately — it does not wait for the drag to finish —
    // so nothing here may report a release. Rust detects the release from the
    // physical button instead.
    await appWindow?.startDragging?.();
  } catch (err) {
    console.error('[companion] drag failed', err);
  }
});

content.addEventListener('pointerup', async (event) => {
  // A press that became a drag is never a click, however the release arrives.
  if (pressWasDrag || event.button !== 0) return;
  pressOrigin = null;

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
      button: 36,
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

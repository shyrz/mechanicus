/**
 * Snap-target overlay.
 *
 * Shown only while the companion is being dragged: it dims the desktop and
 * marks the three landing spots. It polls `snap_overlay_state` on every frame
 * instead of listening for pushed events, because the main thread is inside the
 * native drag loop while this matters — a pushed event would queue up and the
 * highlight would only appear after the drop.
 */

const dim = document.getElementById('dim');
const pillsRoot = document.getElementById('pills');
const core = window.__TAURI__?.core;

/** @type {Map<string, HTMLElement>} */
const pills = new Map();
let active = false;

function ensurePill(target) {
  let el = pills.get(target);
  if (!el) {
    el = document.createElement('div');
    el.className = 'pill';
    el.dataset.target = target;
    const dot = document.createElement('span');
    dot.className = 'pill-dot';
    el.appendChild(dot);
    pillsRoot.appendChild(el);
    pills.set(target, el);
  }
  return el;
}

function apply(state) {
  const shouldShow = Boolean(state?.active);

  if (!shouldShow) {
    if (active) {
      active = false;
      dim.classList.remove('on');
      for (const el of pills.values()) {
        el.classList.remove('on');
        el.classList.remove('active');
      }
    }
    return;
  }

  if (!active) {
    active = true;
    dim.classList.add('on');
  }

  const seen = new Set();
  for (const pill of state.pills ?? []) {
    seen.add(pill.target);
    const el = ensurePill(pill.target);
    el.style.left = `${pill.x}px`;
    el.style.top = `${pill.y}px`;
    el.style.width = `${pill.w}px`;
    el.style.height = `${pill.h}px`;
    el.classList.add('on');
    el.classList.toggle('active', pill.target === state.nearest);
  }

  // Hide any marker the backend no longer reports.
  for (const [target, el] of pills) {
    if (!seen.has(target)) {
      el.classList.remove('on', 'active');
    }
  }
}

async function poll() {
  if (core) {
    try {
      apply(await core.invoke('snap_overlay_state'));
    } catch {
      // The window may be mid-teardown; keep polling.
    }
  }
  setTimeout(() => requestAnimationFrame(poll), 33);
}

requestAnimationFrame(poll);

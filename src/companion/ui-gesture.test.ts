import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';

/**
 * Gesture rules for the companion overlay.
 *
 * `companion-tauri/ui/main.js` normally runs inside a webview, but its gesture
 * handling is ordinary logic: a press that became a drag must never reveal the
 * session. Running the real file — not a copy — against a minimal DOM shim keeps
 * that rule in `bun test` instead of depending on someone dragging the overlay by
 * hand.
 *
 * The regression this exists for: the drag flag was cleared in a `finally` as soon
 * as `startDragging` returned. That call only posts a request and returns
 * immediately — the drag itself runs outside the webview — so by the time the
 * release arrived the flag was already false and the release was treated as a
 * click, which opened the session at the end of every drag.
 */

type Handler = (event: unknown) => unknown;

interface FakeElement {
  handlers: Map<string, Handler[]>;
  style: { setProperty(name: string, value: string): void };
  dataset: Record<string, string>;
  className: string;
  innerHTML: string;
  textContent: string;
  title: string;
  appendChild(node: unknown): void;
  addEventListener(type: string, handler: Handler): void;
  classList: {
    add(name: string): void;
    remove(name: string): void;
    toggle(name: string, force?: boolean): boolean;
    contains(name: string): boolean;
  };
  getBoundingClientRect(): {
    left: number;
    top: number;
    right: number;
    bottom: number;
  };
}

function makeElement(): FakeElement {
  const handlers = new Map<string, Handler[]>();
  const classes = new Set<string>();
  return {
    handlers,
    style: { setProperty: () => {} },
    dataset: {},
    className: '',
    innerHTML: '',
    textContent: '',
    title: '',
    appendChild: () => {},
    addEventListener: (type, handler) => {
      const list = handlers.get(type) ?? [];
      list.push(handler);
      handlers.set(type, list);
    },
    // Backed by a real set, not a no-op: main.js paints hover by toggling a class,
    // and a stub that swallowed it could not tell that the paint happened.
    classList: {
      add: (name) => void classes.add(name),
      remove: (name) => void classes.delete(name),
      toggle: (name, force) => {
        const want = force ?? !classes.has(name);
        if (want) classes.add(name);
        else classes.delete(name);
        return want;
      },
      contains: (name) => classes.has(name),
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0 }),
  };
}

/** Commands the renderer asked the host to run, in order. */
const invokes: string[] = [];

/** Elements the renderer built with `createElement`, in the order it made them. */
const created: FakeElement[] = [];

/** Event listeners the renderer registered, by event name. */
const listeners = new Map<string, Handler[]>();

/** Delivers a payload the way the host would. */
async function emit(name: string, payload: unknown): Promise<void> {
  for (const handler of listeners.get(name) ?? []) await handler({ payload });
}

const STATE = {
  session: {
    session_id: 'ses_gesture_harness',
    cwd: '/tmp/gesture-project',
    project: 'gesture-project',
    status: 'busy',
    agents: ['omnissiah'],
  },
  config: {
    position: 'bottom-right',
    size: 'small',
    speed: 1,
    loop_style: 'classic',
  },
  button: 36,
  cols: 1,
  rows: 1,
  caption: true,
};

let content: FakeElement;
let originalDocument: unknown;
let originalWindow: unknown;

beforeAll(async () => {
  const elements: Record<string, FakeElement> = {
    content: makeElement(),
    grid: makeElement(),
    handle: makeElement(),
    label: makeElement(),
  };
  content = elements.content;

  const globals = globalThis as unknown as Record<string, unknown>;
  originalDocument = globals.document;
  originalWindow = globals.window;

  globals.document = {
    documentElement: makeElement(),
    title: '',
    getElementById: (id: string) => elements[id] ?? null,
    createElement: () => {
      const el = makeElement();
      created.push(el);
      return el;
    },
  };
  globals.window = {
    addEventListener: () => {},
    agentIcon: () => '<svg></svg>',
    __TAURI__: {
      core: {
        invoke: async (cmd: string) => {
          invokes.push(cmd);
          return cmd === 'get_state' ? STATE : undefined;
        },
      },
      window: {
        getCurrentWindow: () => ({
          startDragging: async () => {
            invokes.push('startDragging');
          },
        }),
      },
      event: {
        listen: async (name: string, handler: Handler) => {
          const list = listeners.get(name) ?? [];
          list.push(handler);
          listeners.set(name, list);
          return () => {};
        },
      },
    },
  };

  await import('../../companion-tauri/ui/main.js');
  // Let the renderer's async bootstrap finish: it installs the payload that the
  // reveal path reads, and without it a click would bail out before invoking.
  await Bun.sleep(1);
  invokes.length = 0;
});

afterAll(() => {
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.document = originalDocument;
  globals.window = originalWindow;
});

beforeEach(() => {
  invokes.length = 0;
});

/**
 * Runs every handler the overlay registered for `type`, as the webview would.
 *
 * `buttons` models what the pointer is doing *during* the event: a press or a move
 * with a finger down reports 1, a release reports 0. Leaving it out would let a
 * handler that checks it look correct while never firing in the app.
 */
async function gesture(
  type: string,
  x: number,
  y: number,
  buttons = type === 'pointerup' ? 0 : 1,
): Promise<void> {
  for (const handler of content.handlers.get(type) ?? []) {
    await handler({ button: 0, buttons, clientX: x, clientY: y });
  }
}

describe('companion overlay gestures', () => {
  test('dragging does not reveal the session', async () => {
    await gesture('pointerdown', 10, 10);
    await gesture('pointermove', 80, 80); // past the 4px threshold
    await gesture('pointerup', 80, 80);

    expect(invokes).toEqual(['set_dragging', 'startDragging']);
  });

  test('a click reveals the session', async () => {
    await gesture('pointerdown', 10, 10);
    await gesture('pointerup', 11, 11);

    expect(invokes).toEqual(['reveal_session']);
  });

  test('a second release after a drag still does not reveal', async () => {
    // The compositor may deliver more than one release for a single drag, so the
    // drag flag cannot be consumed by the first one.
    await gesture('pointerdown', 10, 10);
    await gesture('pointermove', 90, 90);
    await gesture('pointerup', 90, 90);
    await gesture('pointerup', 90, 90);

    expect(invokes).toEqual(['set_dragging', 'startDragging']);
  });

  test('a click after a drag still reveals', async () => {
    // The other direction: the drag flag must not stick across presses.
    await gesture('pointerdown', 10, 10);
    await gesture('pointermove', 90, 90);
    await gesture('pointerup', 90, 90);
    invokes.length = 0;

    await gesture('pointerdown', 10, 10);
    await gesture('pointerup', 11, 11);

    expect(invokes).toEqual(['reveal_session']);
  });

  test('a press that never leaves the threshold is still a click', async () => {
    // Movement below the threshold is a click with a shaky hand, not a drag.
    await gesture('pointerdown', 10, 10);
    await gesture('pointermove', 12, 11);
    await gesture('pointerup', 12, 11);

    expect(invokes).toEqual(['reveal_session']);
  });

  test('a press released outside the content does not drag on the next hover', async () => {
    // Docked, the content is smaller than the window, so releasing over the padding
    // delivers the release to `body` and no handler runs. The press must not survive
    // as a drag waiting to happen: a hover move has no button down and must be
    // treated as one.
    await gesture('pointerdown', 10, 10);
    await gesture('pointermove', 12, 12); // below the threshold, still held
    await gesture('pointermove', 40, 40, 0); // hover: nothing is held any more

    expect(invokes).toEqual([]);

    // And the gesture state must recover, so a real drag still works afterwards.
    await gesture('pointerdown', 10, 10);
    await gesture('pointermove', 80, 80);

    expect(invokes).toEqual(['set_dragging', 'startDragging']);
  });

  test('hover is painted from the cursor the poll publishes', async () => {
    // This overlay is never the key window, so it cannot rely on the webview
    // delivering the moves CSS `:hover` needs. The position Rust publishes while
    // the pointer is inside is what has to light the button up instead.
    const tile = created[0];
    expect(tile).toBeDefined();
    // A 36px disc at the origin, and a second button beside it.
    tile.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      right: 36,
      bottom: 36,
    });

    const snap = (cursor?: number[]) => ({
      snapped: true,
      target: 'bottom',
      progress: 0,
      content: [0, 0, 84, 68],
      expanded: true,
      ...(cursor ? { cursor } : {}),
    });

    await emit('companion://snap', snap([10, 10]));
    expect(tile.classList.contains('cursor-over')).toBe(true);

    // Moving off it takes the class away again.
    await emit('companion://snap', snap([200, 200]));
    expect(tile.classList.contains('cursor-over')).toBe(false);

    // And the pointer leaving the window entirely (no cursor published) too.
    await emit('companion://snap', snap([10, 10]));
    await emit('companion://snap', snap());
    expect(tile.classList.contains('cursor-over')).toBe(false);
  });
});

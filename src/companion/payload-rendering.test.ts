import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guards for the decisions that moved out of JavaScript.
 *
 * Each of these used to be made twice -- a colour literal in both main.js and the
 * stylesheet, the caption's visibility in both Rust's payload and a CSS selector --
 * and a duplicated decision is one that can disagree with itself. These pin the
 * single owner, because the failure mode is silent: the second copy keeps working
 * until the day the first one changes.
 */

const ROOT = join(import.meta.dir, '..', '..');
const CSS = readFileSync(join(ROOT, 'companion-tauri/ui/style.css'), 'utf8');
const JS = readFileSync(join(ROOT, 'companion-tauri/ui/main.js'), 'utf8');

describe('companion rendering decisions', () => {
  /** Status names the stylesheet maps to a colour, from `.content[data-status=…]`. */
  function mappedStatuses(): Set<string> {
    return new Set(
      [...CSS.matchAll(/\.content\[data-status=['"]([a-z-]+)['"]\]/g)].map(
        (m) => m[1],
      ),
    );
  }

  test('every status that lights a ring has a colour mapped to it', () => {
    // The buttons' ring and the collapsed handle's bar both read `--status-color`,
    // which the container maps from the status name. A state that raises a ring with
    // no mapping paints nothing, which is exactly how `busy` was broken: the
    // stylesheet could raise the ring and had no colour to put in it.
    const mapped = mappedStatuses();
    expect(mapped.size).toBeGreaterThan(0);

    let ringed = 0;
    for (const match of CSS.matchAll(
      /\.tile\.(state-[a-z-]+)\s*\{([^}]*)\}/g,
    )) {
      const [, name, block] = match;
      const ring = Number(/--status-ring:\s*([\d.]+)/.exec(block)?.[1] ?? '0');
      if (ring <= 0) continue;
      ringed += 1;
      expect(
        mapped.has(name.replace('state-', '')),
        `${name} raises a ring but has no colour mapping`,
      ).toBe(true);
    }
    // Guards the loop itself: a rename that stopped these rules matching would
    // otherwise make the assertions above vacuous.
    expect(ringed).toBeGreaterThan(0);
  });

  test('the collapsed bar carries the status, the idle bar the edge colour', () => {
    // The buttons are faded out while collapsed, so the bar is where a status stays
    // visible; idle has to fall back to the edge colour, or an ordinary docked
    // handle stops matching the border it was specified against.
    const bar = /\.handle-grip::after\s*\{([^}]*)\}/.exec(CSS)?.[1] ?? '';
    expect(bar).toMatch(/background:\s*var\(--status-color,\s*#434343\)/);
    const edge = /\.handle-grip::before\s*\{([^}]*)\}/.exec(CSS)?.[1] ?? '';
    expect(/border-top-color:\s*(#[0-9a-f]{6})/i.exec(edge)?.[1]).toBe(
      '#434343',
    );
  });

  test('the status colours are defined once, in the stylesheet', () => {
    for (const token of ['--status-waiting-input', '--status-busy']) {
      expect(CSS).toContain(`${token}:`);
    }
    // The script must not own a second copy, nor set the colour itself: it names
    // the status and nothing more.
    expect(JS).not.toMatch(/--status-color/);
    expect(JS).not.toMatch(/rgba\(\s*255,\s*176,\s*32/);
    expect(JS).not.toMatch(/rgba\(\s*64,\s*200,\s*120/);
    expect(JS).toMatch(/content\.dataset\.status = status/);
  });

  test('the caption is drawn from the payload, not decided again in CSS', () => {
    // Rust owns the footprint, so it owns the decision.
    expect(JS).toMatch(
      /classList\.toggle\('is-hidden', p\.caption === false\)/,
    );
    expect(CSS).toContain('.label.is-hidden');
    // The old second copy: a selector repeating what the payload already says.
    expect(CSS).not.toMatch(/target-(left|right) \.label/);
  });

  test('hover is painted from the cursor the poll publishes', () => {
    expect(JS).toMatch(/cursorAt = s\.cursor \?/);
    expect(JS).toMatch(/classList\.toggle\('cursor-over'/);
    // One rule, both selectors: dropping either silently kills hover for whichever
    // path the webview actually takes.
    expect(CSS).toMatch(/\.tile:hover,\s*\.tile\.cursor-over\s*\{/);
    expect(CSS).toMatch(
      /\.content\.collapsed:hover \.handle-grip,\s*\.content\.collapsed\.cursor-over \.handle-grip\s*\{/,
    );
  });
});

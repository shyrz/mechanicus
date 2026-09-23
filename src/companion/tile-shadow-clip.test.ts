import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The tile's drop shadow must fade out inside the grid padding.
 *
 * The native window is sized to the content, so whatever a shadow paints past the
 * padding is cut off by the window edge. A cut-off shadow stops fading and ends in
 * a straight line; because the window clips on both sides, the button ends up
 * ringed by a faint square. It is invisible over a wallpaper and obvious during a
 * drag, when the snap overlay flattens the backdrop into one grey — which is how it
 * was found: by measuring a screenshot, not by reading the CSS.
 *
 * The constraint spans two files (the shadow is in the stylesheet, the room it has
 * is main.rs's padding), so it is pinned here rather than trusted to a comment. For
 * a softer shadow, raise GRID_PAD to match and this passes again.
 */

const ROOT = join(import.meta.dir, '..', '..');
const CSS = readFileSync(join(ROOT, 'companion-tauri/ui/style.css'), 'utf8');
const RUST = readFileSync(
  join(ROOT, 'companion-tauri/src-tauri/src/main.rs'),
  'utf8',
);

/** The grid padding: how far a shadow may reach before the window edge. */
function gridPad(): number {
  const match = /const GRID_PAD: f32 = ([\d.]+);/.exec(RUST);
  if (!match) throw new Error('GRID_PAD not found in main.rs');
  return Number(match[1]);
}

interface Shadow {
  selector: string;
  reach: number;
}

/**
 * Numbers in a shadow layer, in order: x-offset, y-offset, blur, spread.
 *
 * Colours are stripped first so their components are not read as lengths, and a
 * bare `0` counts as a length — CSS allows a unitless zero, and the x-offset is
 * written that way, so requiring `px` would silently skip the very shadows this
 * checks.
 */
function lengthsOf(layer: string): number[] {
  const withoutColor = layer
    .replace(/rgba?\([^)]*\)/gi, ' ')
    .replace(/hsla?\([^)]*\)/gi, ' ')
    .replace(/#[0-9a-f]+/gi, ' ')
    .replace(/\binset\b/g, ' ');
  const tokens = withoutColor.match(/-?(?:\d+\.?\d*|\.\d+)(?:px)?/g) ?? [];
  return tokens.map((token) => Number.parseFloat(token));
}

/**
 * Splits a shadow list on commas that sit outside parentheses.
 *
 * A plain `split(',')` also breaks the commas inside `rgba(...)`, and the colour
 * components then parse as lengths — which is how a 255px "reach" appears out of
 * nowhere.
 */
function splitLayers(value: string): string[] {
  const layers: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of value) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      layers.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  layers.push(current);
  return layers;
}

/** Every outer (non-inset) drop shadow declared on a `.tile` rule. */
function tileDropShadows(): Shadow[] {
  const found: Shadow[] = [];
  for (const rule of CSS.matchAll(/(\.tile[^{]*)\{([^}]*)\}/g)) {
    const selector = rule[1].trim().replace(/\s+/g, ' ');
    const declaration = /box-shadow:\s*([^;]+);/.exec(rule[2]);
    if (!declaration) continue;

    // An inset layer never leaves the element.
    for (const layer of splitLayers(declaration[1])) {
      if (layer.includes('inset')) continue;
      const [offsetX = 0, offsetY = 0, blur = 0] = lengthsOf(layer);
      // Worst case over both axes: the offset pushes the shadow out on one side
      // and the blur extends past it.
      found.push({
        selector,
        reach: Math.max(Math.abs(offsetX), Math.abs(offsetY)) + Math.abs(blur),
      });
    }
  }
  return found;
}

describe('companion tile shadow', () => {
  test('the parser finds the resting and hover shadows', () => {
    // Guards the parser itself: a rename that stopped these rules matching would
    // otherwise make the assertion below vacuous.
    const shadows = tileDropShadows();
    expect(shadows.map((s) => s.selector)).toEqual([
      '.tile',
      '.tile:hover, .tile.cursor-over',
    ]);
  });

  test('every drop shadow fades inside the grid padding', () => {
    const pad = gridPad();
    expect(pad).toBeGreaterThan(0);
    for (const shadow of tileDropShadows()) {
      expect(
        shadow.reach,
        `${shadow.selector} shadow reaches ${shadow.reach}px, past the ${pad}px padding`,
      ).toBeLessThanOrEqual(pad);
    }
  });
});

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The button's edge is per-side, and that is not a typo.
 *
 * Sampled from OpenCode's own surfaces -- the resting fill from the "jump to
 * latest" control, the hover fill from the prompt box. On both references the top
 * hairline measures about twice the alpha of the sides (0x43 vs 0x2d over a 0x16
 * page) and the bottom measures nothing at all: the bottom row is the fill and
 * nothing else. That asymmetry is what makes the top edge read as catching the
 * light, so flattening it into one uniform ring is a visible regression, and it is
 * exactly the "cleanup" someone would make on sight.
 *
 * Pinned here rather than left to a comment for that reason: the rule looks wrong,
 * and the only way it survives review is if undoing it fails something.
 */

const ROOT = join(import.meta.dir, '..', '..');
const CSS = readFileSync(join(ROOT, 'companion-tauri/ui/style.css'), 'utf8');

/**
 * The declarations of the first rule whose selector matches.
 *
 * Whitespace in the selector is matched loosely: a rule carrying two selectors is
 * written across two lines, and requiring the space in `A, B` to stay a space
 * would fail on a rule that is perfectly correct.
 */
function declarationsOf(selector: string): string {
  const pattern = selector
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+');
  const match = new RegExp(
    `(?:^|\\})\\s*${pattern}\\s*\\{([^}]*)\\}`,
    'm',
  ).exec(CSS);
  if (!match) throw new Error(`no rule found for ${selector}`);
  return match[1];
}

function declared(block: string, property: string): string {
  const match = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+);`).exec(
    block,
  );
  if (!match) throw new Error(`no ${property} declaration`);
  return match[1].trim();
}

describe('companion button edge', () => {
  test('the fills come from the two references', () => {
    expect(declared(declarationsOf('.tile'), 'background')).toBe('#161616');
    expect(
      declared(declarationsOf('.tile:hover, .tile.cursor-over'), 'background'),
    ).toBe('#242424');
  });

  test('the top hairline is brighter than the sides', () => {
    const edge = declarationsOf('.tile::before');
    const top = declared(edge, 'border-top-color');
    const left = declared(edge, 'border-left-color');
    const right = declared(edge, 'border-right-color');
    expect(top).toBe('#434343');
    expect(left).toBe('#2d2d2d');
    expect(right).toBe('#2d2d2d');
    expect(Number.parseInt(top.slice(1), 16)).toBeGreaterThan(
      Number.parseInt(left.slice(1), 16),
    );
  });

  test('the bottom edge is not drawn', () => {
    const edge = declarationsOf('.tile::before');
    // The base border supplies the bottom, so it has to stay transparent for the
    // fill to show through there.
    expect(declared(edge, 'border')).toContain('transparent');
    expect(edge).not.toContain('border-bottom-color');
  });

  test('the edge is an overlay, not a border on the button', () => {
    // A real border would shrink the content box the icon is sized against.
    expect(declarationsOf('.tile')).not.toMatch(
      /\bborder(-top|-left|-right)?\s*:/,
    );
  });
});

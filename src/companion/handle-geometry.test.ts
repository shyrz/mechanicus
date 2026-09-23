import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The handle's geometry is written twice: `HANDLE_THICK` / `HANDLE_LONG` in snap.rs
 * size the box, and `.handle-grip` in the stylesheet draws the pill inside it. The
 * two have to agree or the pill stops matching the control it represents -- and
 * nothing else would notice, because the box is invisible. `GRID_PAD` has been
 * pinned this way since a shadow was found clipped by it; this is the same class of
 * constraint, so it gets the same treatment.
 */

const ROOT = join(import.meta.dir, '..', '..');
const CSS = readFileSync(join(ROOT, 'companion-tauri/ui/style.css'), 'utf8');
const RUST = readFileSync(
  join(ROOT, 'companion-tauri/src-tauri/src/snap.rs'),
  'utf8',
);

function rustConst(name: string): number {
  const match = new RegExp(`const ${name}: f64 = ([\\d.]+);`).exec(RUST);
  if (!match) throw new Error(`${name} not found in snap.rs`);
  return Number(match[1]);
}

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(CSS);
  if (!match) throw new Error(`no rule found for ${selector}`);
  return match[1];
}

function px(block: string, property: string): number {
  const match = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([\\d.]+)px;`).exec(
    block,
  );
  if (!match) throw new Error(`no ${property} in px`);
  return Number(match[1]);
}

describe('companion handle geometry', () => {
  test('the vertical pill is the handle box, turned upright', () => {
    const vertical = rule('.content.target-right .handle-grip');
    expect(px(vertical, 'width')).toBe(rustConst('HANDLE_THICK'));
    expect(px(vertical, 'height')).toBe(rustConst('HANDLE_LONG'));
  });

  test('the horizontal pill is the same box rotated', () => {
    const horizontal = rule('.content.target-bottom .handle-grip');
    expect(px(horizontal, 'width')).toBe(rustConst('HANDLE_LONG'));
    expect(px(horizontal, 'height')).toBe(rustConst('HANDLE_THICK'));
  });

  test('the bar is 4 x 48 and fully rounded, whichever way it runs', () => {
    const bar = rule('.handle-grip::after');
    const vertical = [px(bar, 'width'), px(bar, 'height')];
    expect(vertical).toEqual([4, 48]);
    // Rounded caps: the radius is half the short side, or the ends look cut.
    expect(px(bar, 'border-radius')).toBe(vertical[0] / 2);

    const turned = rule('.content.target-bottom .handle-grip::after');
    expect([px(turned, 'width'), px(turned, 'height')]).toEqual([48, 4]);
  });

  test('the bar carries the status and falls back to the edge colour', () => {
    const bar = rule('.handle-grip::after');
    const edge = rule('.handle-grip::before');
    const top = /border-top-color:\s*(#[0-9a-f]{6})/i.exec(edge)?.[1];
    const fill = /background:\s*(#[0-9a-f]{6})/i.exec(
      rule('.handle-grip'),
    )?.[1];

    // Collapsed, the bar is where a status stays visible; with no status it has to
    // land on the edge colour, which is what the design asked the bar to match.
    const fallback = /var\(--status-color,\s*(#[0-9a-f]{6})\)/i.exec(bar)?.[1];
    expect(fallback).toBeDefined();
    expect(fallback).toBe(top);
    expect(fallback).not.toBe(fill);
  });

  test('the grip carries the same per-side edge as the buttons', () => {
    const edge = rule('.handle-grip::before');
    const tile = rule('.tile::before');
    for (const side of [
      'border-top-color',
      'border-left-color',
      'border-right-color',
    ]) {
      const from = new RegExp(`${side}:\\s*(#[0-9a-f]{6})`, 'i');
      expect(from.exec(edge)?.[1]).toBe(from.exec(tile)?.[1]);
    }
    expect(edge).not.toContain('border-bottom-color');
  });
});

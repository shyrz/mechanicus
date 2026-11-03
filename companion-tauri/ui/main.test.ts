import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const uiDir = dirname(fileURLToPath(import.meta.url));
const mainSource = readFileSync(resolve(uiDir, 'main.js'), 'utf8');
const stylesheet = readFileSync(resolve(uiDir, 'style.css'), 'utf8');

function loadOverlay(api?: object) {
  const dom = new JSDOM(
    readFileSync(resolve(uiDir, 'index.html'), 'utf8').replace(
      /<script[^>]*><\/script>/g,
      '',
    ),
    { runScripts: 'outside-only', url: 'https://companion.test/' },
  );
  const style = dom.window.document.createElement('style');
  style.textContent = stylesheet;
  dom.window.document.head.appendChild(style);
  dom.window.agentIcon = () => '<svg viewBox="0 0 24 24"></svg>';
  if (api) Object.defineProperty(dom.window, '__TAURI__', { value: api });
  dom.window.eval(
    `(() => {${mainSource}\nwindow.companionRender = render;})()`,
  );
  return dom;
}

function waitForAsyncSetup() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function statusColor(status: string) {
  const declaration = stylesheet
    .split('\n')
    .find((line) => line.trim().startsWith(`--status-${status}:`))
    ?.trim();
  expect(declaration).toMatch(
    /^--status-(?:waiting-input|busy): #[0-9a-f]{6};$/,
  );
  if (!declaration) throw new Error(`Missing ${status} status colour`);
  const channels = declaration.match(/[0-9a-f]{2}/g);
  expect(channels).toHaveLength(3);
  if (!channels) throw new Error(`Invalid ${status} status colour`);
  return channels.map((channel) => Number.parseInt(channel, 16));
}

function relativeLuminance([red, green, blue]: number[]) {
  const linear = [red, green, blue].map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

describe('project label', () => {
  test('requests a tooltip for the hovered icon even on a side dock', async () => {
    const calls: { command: string; args: unknown }[] = [];
    const listeners = new Map<string, (event: unknown) => void>();
    const project = 'a-long-project-name-that-needs-more-than-one-line';
    const dom = loadOverlay({
      core: {
        invoke: async (command: string, args: unknown) => {
          calls.push({ command, args });
          if (command === 'get_state') {
            return {
              session: {
                session_id: 'preview',
                cwd: `/projects/${project}`,
                project,
                status: 'busy',
                agents: ['orchestrator'],
              },
              config: {},
              button: 44,
              cols: 1,
              rows: 1,
            };
          }
        },
      },
      event: {
        listen: async (name: string, handler: (event: unknown) => void) => {
          listeners.set(name, handler);
          return () => {};
        },
      },
      window: { getCurrentWindow: () => ({}) },
    });
    await waitForAsyncSetup();
    const tile = dom.window.document.querySelector('.tile');
    if (!tile) throw new Error('Overlay preview did not render');
    tile.getBoundingClientRect = () =>
      ({ left: 6, top: 6, right: 50, bottom: 50 }) as DOMRect;
    tile.dispatchEvent(new dom.window.Event('pointerenter'));

    expect(calls).toContainEqual({
      command: 'set_project_tooltip',
      args: { request: { project, anchor: [6, 6, 44, 44] } },
    });

    tile.dispatchEvent(new dom.window.Event('pointerleave'));
    expect(calls.at(-1)).toEqual({
      command: 'set_project_tooltip',
      args: { request: null },
    });

    const snap = listeners.get('companion://snap');
    if (!snap) throw new Error('Snap listener was not installed');
    snap({
      payload: {
        snapped: true,
        target: 'left',
        progress: 0,
        content: [0, 0, 56, 56],
        cursor: [20, 20],
      },
    });
    expect(calls.at(-1)).toEqual({
      command: 'set_project_tooltip',
      args: { request: { project, anchor: [6, 6, 44, 44] } },
    });
    snap({
      payload: {
        snapped: true,
        target: 'left',
        progress: 0,
        content: [0, 0, 56, 56],
      },
    });
    expect(calls.at(-1)).toEqual({
      command: 'set_project_tooltip',
      args: { request: null },
    });
    dom.window.close();
  });
});

describe('status palette', () => {
  test.each(['waiting-input', 'busy'])(
    '%s is brighter against the icon surface',
    (status) => {
      const previousPalette = {
        'waiting-input': [246, 170, 34],
        busy: [58, 173, 105],
      };
      const previous = previousPalette[status as keyof typeof previousPalette];

      expect(relativeLuminance(statusColor(status))).toBeGreaterThan(
        relativeLuminance(previous),
      );
    },
  );

  test('both status rings use their full-strength palette', () => {
    const rules = stylesheet.match(
      /\.tile\.state-(?:waiting-input|busy)\s*\{\s*--status-ring:\s*1;\s*\}/g,
    );
    expect(rules).toHaveLength(2);
  });
});

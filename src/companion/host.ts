/**
 * Which application is hosting the plugin.
 *
 * The companion has to know what a click can actually achieve, because that
 * differs per host. A TUI owns a router, so a click can open a session. The
 * desktop app cannot focus a session -- `opencode://session/<id>` reaches its
 * renderer and is dropped, and upstream closed the request as "not planned" --
 * so the most a click can do there is raise the app with that same URL.
 *
 * Only hosts that change the companion's behaviour are recognised. Anything
 * unrecognised is left undefined, which the companion treats as "assume a
 * session can be opened": that is the right default for every TUI-shaped host,
 * including v1 hosts, which carry no host identity at all.
 */

/** Hosts, as published in the state file's `host.kind`. */
export const DESKTOP_HOST_KIND = 'desktop';

export interface CompanionHost {
  kind: typeof DESKTOP_HOST_KIND;
  /**
   * macOS bundle used to raise the app, as a fallback for when the URL scheme
   * is not handled.
   *
   * Snake case, like every other field in the state file. The companion
   * deserializes into a fixed struct that ignores unknown keys, so a camelCase
   * spelling is dropped silently instead of failing loudly -- the host would
   * still be recognised, but this field would arrive empty.
   */
  bundle_id?: string;
}

/** `ctx.app.name` for the desktop app. */
const DESKTOP_APP_NAME = 'desktop';

/**
 * The desktop app's bundle identifier.
 *
 * Taken from its `Info.plist`, not guessed: the bundle is addressed by
 * identifier because that survives the app being moved or renamed.
 */
const DESKTOP_BUNDLE_ID = 'ai.opencode.desktop';

/**
 * Describes the host, or `undefined` when a click should go to the session
 * request channel instead.
 */
export function describeHost(
  appName: string | undefined,
): CompanionHost | undefined {
  const name = appName?.trim().toLowerCase();
  if (name !== DESKTOP_APP_NAME) return undefined;
  return { kind: DESKTOP_HOST_KIND, bundle_id: DESKTOP_BUNDLE_ID };
}

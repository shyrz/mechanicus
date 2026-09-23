/**
 * Nucleo icon bodies, one per agent role.
 *
 * Icons are inlined rather than fetched: the webview is offline and the bundle
 * has no asset pipeline, so the markup ships with the source.
 *
 * These are the raw `<svg>` bodies from the `sharp` family, outline, 24px. They
 * carry Nucleo's own customization hooks, which is why they are pasted verbatim
 * instead of normalized:
 *
 * - `stroke="currentColor"` / `fill="currentColor"` — the button sets the
 *   colour, so the icon follows.
 * - `data-color="color-2"` — the parts meant to take a secondary colour. The
 *   filled accents also carry `data-stroke="none"`. At this size the glyph is
 *   single-colour, so nothing sets it; the hooks are kept so a two-tone
 *   treatment stays a CSS change.
 *
 * Corners are the family default (square). `sharp` ships no `--nucleo-*`
 * hooks — stroke width is a hard-coded 2 and caps are square — and Nucleo
 * exposes corner overrides for `core` outline only, so the bodies stay exactly
 * as drawn here.
 *
 * Mapping is by role, not by name: the icons describe what each agent does.
 *
 * A classic script, not a module: the page loads its scripts by plain `<script
 * src>` and the webview has no bundler, so `agentIcon` is published on
 * `window` for the renderer to use.
 */
(() => {
  /** `<svg>` wrapper shared by every icon, so callers just supply a body. */
  const VIEW_BOX = '0 0 24 24';

  /**
   * Agent role → icon body.
   *
   * `councillor-*` sessions share the councillor icon, matching how the original
   * companion mapped dynamic councillors onto one animation.
   */
  const ICON_BODIES = {
    // Primarch of the forges: leads and coordinates every other agent.
    // Icon: sharp/robot.
    omnissiah:
      '<path d="M12 15V20" stroke="currentColor" stroke-width="2" stroke-linecap="square" data-color="color-2" fill="none"></path> <path d="M6 20V15H18V20" stroke="currentColor" stroke-width="2" stroke-linecap="square" data-color="color-2" fill="none"></path> <path d="M12 4V1" stroke="currentColor" stroke-width="2" stroke-linecap="square" fill="none"></path> <path d="M22 4L2 4L2 20L22 20L22 4Z" stroke="currentColor" stroke-width="2" stroke-miterlimit="10" stroke-linecap="square" data-color="color-2" fill="none"></path> <rect x="7" y="8" width="3" height="3" fill="currentColor" data-stroke="none"></rect> <rect x="14" y="8" width="3" height="3" fill="currentColor" data-stroke="none"></rect>',
    // Codebase navigation: find the file, find the symbol.
    // Icon: sharp/robot-time.
    magos:
      '<path d="M12.5 14C12.0473 14.6026 11.6847 15.276 11.4287 16H7V20H5V14H12.5Z" fill="currentColor" data-color="color-2" data-stroke="none"></path> <path d="M12 4V1" stroke="currentColor" stroke-width="2" stroke-linecap="square" data-color="color-2" fill="none"></path> <rect x="7" y="8" width="3" height="3" fill="currentColor" data-stroke="none"></rect> <rect x="14" y="8" width="3" height="3" fill="currentColor" data-stroke="none"></rect> <path d="M18.5 23C20.9853 23 23 20.9853 23 18.5C23 16.0147 20.9853 14 18.5 14C16.0147 14 14 16.0147 14 18.5C14 20.9853 16.0147 23 18.5 23Z" stroke="currentColor" stroke-width="2" stroke-miterlimit="10" stroke-linecap="square" fill="none"></path> <path d="M23 12.5C22.3973 12.0473 21.7242 11.6837 21 11.4277V5H3V19H11.0186C11.0645 19.6971 11.2052 20.3678 11.4287 21H1V3H23V12.5Z" fill="currentColor" data-color="color-2" data-stroke="none"></path> <path d="M19.5 19.5L18.5 18.5L18.5 17" stroke="currentColor" stroke-width="2" stroke-miterlimit="10" stroke-linecap="square" fill="none"></path>',
    // Research across code and documentation.
    // Icon: sharp/robot-search.
    logis:
      '<path d="M12.0244 14C11.6364 14.6057 11.3461 15.2793 11.1758 16H7V20H5V14H12.0244Z" fill="currentColor" data-color="color-2" data-stroke="none"></path> <path d="M12 4V1" stroke="currentColor" stroke-width="2" stroke-linecap="square" data-color="color-2" fill="none"></path> <rect x="7" y="8" width="3" height="3" fill="currentColor" data-stroke="none"></rect> <rect x="14" y="8" width="3" height="3" fill="currentColor" data-stroke="none"></rect> <path d="M17.5 21C19.433 21 21 19.433 21 17.5C21 15.567 19.433 14 17.5 14C15.567 14 14 15.567 14 17.5C14 19.433 15.567 21 17.5 21Z" stroke="currentColor" stroke-width="2" stroke-miterlimit="10" stroke-linecap="square" fill="none"></path> <path d="M23 14.0381C22.4894 13.2286 21.8057 12.5405 21 12.0244V5H3V19H11.1758C11.3461 19.7207 11.6364 20.3943 12.0244 21H1V3H23V14.0381Z" fill="currentColor" data-color="color-2" data-stroke="none"></path> <path d="M22 22L19.975 19.975L20.5 20.5" stroke="currentColor" stroke-width="2" stroke-miterlimit="10" stroke-linecap="square" fill="none"></path>',
    // Strategic advice and review: judgement, not action.
    // Icon: sharp/robot-sparkle.
    dominus:
      '<path d="M11.6016 14C11.2897 14.6098 11.0879 15.2848 11.0234 16H7V20H5V14H11.6016Z" fill="currentColor" data-color="color-2" data-stroke="none"></path> <path d="M12 4V1" stroke="currentColor" stroke-width="2" stroke-linecap="square" data-color="color-2" fill="none"></path> <rect x="7" y="8" width="3" height="3" fill="currentColor" data-stroke="none"></rect> <rect x="14" y="8" width="3" height="3" fill="currentColor" data-stroke="none"></rect> <path d="M10 20L2 20L2 4L22 4L22 11" stroke="currentColor" stroke-width="2" stroke-miterlimit="10" stroke-linecap="square" data-color="color-2" fill="none"></path> <path d="M20.2578 20.2578L23 19.0114V17.9886L20.2578 16.7422L19.0114 14H17.9886L16.7422 16.7422L14 17.9886L14 19.0114L16.7422 20.2578L17.9886 23H18.5H19.0114L20.2578 20.2578Z" stroke="currentColor" stroke-width="2" stroke-miterlimit="10" stroke-linecap="square" fill="none"></path>',
    // UI/UX: craft the interface.
    // Icon: sharp/robot-heart.
    artisan:
      '<path d="M11.6016 14C11.2897 14.6098 11.0879 15.2848 11.0234 16H7V20H5V14H11.6016Z" fill="currentColor" data-color="color-2" data-stroke="none"></path> <path d="M12 4V1" stroke="currentColor" stroke-width="2" stroke-linecap="square" data-color="color-2" fill="none"></path> <rect x="7" y="8" width="3" height="3" fill="currentColor" data-stroke="none"></rect> <rect x="14" y="8" width="3" height="3" fill="currentColor" data-stroke="none"></rect> <path d="M14.7322 14.7322C13.7559 15.7085 13.7559 17.2915 14.7322 18.2678L18.5 22L22.2678 18.2678C23.2441 17.2915 23.2441 15.7085 22.2678 14.7322C21.2915 13.7559 19.7085 13.7559 18.7322 14.7322C18.6475 14.817 18.5701 14.9069 18.5 15C18.4299 14.9069 18.3525 14.817 18.2678 14.7322C17.2915 13.7559 15.7085 13.7559 14.7322 14.7322Z" stroke="currentColor" stroke-width="2" fill="none"></path> <path d="M23 11.6006C22.3903 11.2889 21.715 11.0879 21 11.0234V5H3V19H11.2539L13.2529 21H1V3H23V11.6006Z" fill="currentColor" data-color="color-2" data-stroke="none"></path>',
    // Focused implementation: build and repair.
    // Icon: sharp/robot-pen.
    genetor:
      '<path d="M12.7588 16H7V20H5V14H14.7588L12.7588 16Z" fill="currentColor" data-color="color-2" data-stroke="none"></path> <path d="M12 4V1" stroke="currentColor" stroke-width="2" stroke-linecap="square" data-color="color-2" fill="none"></path> <rect x="7" y="8" width="3" height="3" fill="currentColor" data-stroke="none"></rect> <rect x="14" y="8" width="3" height="3" fill="currentColor" data-stroke="none"></rect> <path d="M17 22L22.5 16.5L19.5 13.5L14 19V22H17Z" stroke="currentColor" stroke-width="2" stroke-miterlimit="10" stroke-linecap="square" fill="none"></path> <path d="M23 12.7588L21 10.7588V5H3V19H11V21H1V3H23V12.7588Z" fill="currentColor" data-color="color-2" data-stroke="none"></path>',
    // Visual analysis: read images, screenshots, diagrams.
    // Icon: sharp/robot-sparkle-2.
    observer:
      '<path d="M10 12V10" stroke="currentColor" stroke-width="2" stroke-linecap="square" data-color="color-2" fill="none"></path> <path d="M9 16V15" stroke="currentColor" stroke-width="2" stroke-linecap="square" fill="none"></path> <path d="M13 16V15" stroke="currentColor" stroke-width="2" stroke-linecap="square" fill="none"></path> <path d="M16 12L4 12L4 21L16 21L16 12Z" stroke="currentColor" stroke-width="2" stroke-miterlimit="10" stroke-linecap="square" data-color="color-2" fill="none"></path> <path d="M3.82812 6.17188L2 5.34091V4.65909L3.82812 3.82812L4.65909 2H5.34091L6.17187 3.82812L8 4.65909L8 5.34091L6.17187 6.17188L5.34091 8H5H4.65909L3.82812 6.17188Z" fill="currentColor" data-stroke="none"></path> <rect x="9" y="1" width="2" height="2" fill="currentColor" data-stroke="none"></rect> <path d="M20.5625 6.5625L19.2273 9L18.7727 9L17.4375 6.5625L15 5.22727L15 4.77273L17.4375 3.4375L18.7727 1L19 1L19.2273 1L20.5625 3.4375L23 4.77273L23 5L23 5.22727L20.5625 6.5625Z" stroke="currentColor" stroke-width="2" stroke-miterlimit="10" stroke-linecap="square" fill="none"></path>',
    // Synthesis across models: several voices, one answer.
    // Icon: sharp/bots.
    council:
      '<path d="M8 12V10" stroke="currentColor" stroke-width="2" stroke-linecap="square" fill="none"></path> <path d="M16 3V1" stroke="currentColor" stroke-width="2" stroke-linecap="square" data-color="color-2" fill="none"></path> <path d="M6 17V16" stroke="currentColor" stroke-width="2" stroke-linecap="square" fill="none"></path> <path d="M10 17V16" stroke="currentColor" stroke-width="2" stroke-linecap="square" fill="none"></path> <path d="M14 12L2 12L2 21L14 21L14 12Z" stroke="currentColor" stroke-width="2" stroke-miterlimit="10" stroke-linecap="square" fill="none"></path> <path d="M10 6L10 3L22 3L22 12L18 12" stroke="currentColor" stroke-width="2" stroke-miterlimit="10" stroke-linecap="square" data-color="color-2" fill="none"></path> <path d="M14 8V7" stroke="currentColor" stroke-width="2" stroke-linecap="square" data-color="color-2" fill="none"></path> <path d="M18 8V7" stroke="currentColor" stroke-width="2" stroke-linecap="square" data-color="color-2" fill="none"></path>',
    // One independent analysis among the council.
    // Icon: sharp/bot-task.
    councillor:
      '<path d="M20 16H22" stroke="currentColor" stroke-width="2" stroke-linecap="square" data-color="color-2" fill="none"></path> <path d="M2 16H4" stroke="currentColor" stroke-width="2" stroke-linecap="square" data-color="color-2" fill="none"></path> <path d="M8 14V16" stroke="currentColor" stroke-width="2" stroke-linecap="square" fill="none"></path> <path d="M13 14V16" stroke="currentColor" stroke-width="2" stroke-linecap="square" fill="none"></path> <path d="M4 21H20V11H4V21Z" stroke="currentColor" stroke-width="2" stroke-linecap="square" data-color="color-2" fill="none"></path> <path d="M4 7H8V3H4V7Z" stroke="currentColor" stroke-width="2" stroke-linecap="square" fill="none"></path> <path d="M12 7H12.01" stroke="currentColor" stroke-width="2" stroke-linecap="square" fill="none"></path> <path d="M20 7H16" stroke="currentColor" stroke-width="2" stroke-linecap="square" fill="none"></path> <path d="M16 3H12" stroke="currentColor" stroke-width="2" stroke-linecap="square" fill="none"></path>',
    // Idle / no agent yet: the machine at rest.
    // Icon: sharp/bot-sleep.
    intro:
      '<path d="M20 16H22" stroke="currentColor" stroke-width="2" stroke-linecap="square" data-color="color-2" fill="none"></path> <path d="M2 16H4" stroke="currentColor" stroke-width="2" stroke-linecap="square" data-color="color-2" fill="none"></path> <path d="M7 11H4V21H20V11H18" stroke="currentColor" stroke-width="2" stroke-linecap="square" data-color="color-2" fill="none"></path> <path d="M10 17H8" stroke="currentColor" stroke-width="2" stroke-linecap="square" fill="none"></path> <path d="M16 17H14" stroke="currentColor" stroke-width="2" stroke-linecap="square" fill="none"></path> <path d="M11 7H14V7.71429L11 10.2857V11H14" stroke="currentColor" stroke-width="2" stroke-linecap="square" fill="none"></path> <path d="M18 2H21V2.57143L18 5.42857V6H21" stroke="currentColor" stroke-width="2" stroke-linecap="square" fill="none"></path>',
    // Waiting on the user: an agent, not a person.
    // Icon: sharp/bot-plus.
    input:
      '<path d="M20 16H22" stroke="currentColor" stroke-width="2" stroke-linecap="square" data-color="color-2" fill="none"></path> <path d="M2 16H4" stroke="currentColor" stroke-width="2" stroke-linecap="square" data-color="color-2" fill="none"></path> <path d="M11 14V16" stroke="currentColor" stroke-width="2" stroke-linecap="square" fill="none"></path> <path d="M16 14V16" stroke="currentColor" stroke-width="2" stroke-linecap="square" fill="none"></path> <path d="M4 21H20V11H4V21Z" stroke="currentColor" stroke-width="2" stroke-linecap="square" data-color="color-2" fill="none"></path> <path d="M17 4H23" stroke="currentColor" stroke-width="2" stroke-miterlimit="10" stroke-linecap="square" fill="none"></path> <path d="M20 1V7" stroke="currentColor" stroke-width="2" stroke-miterlimit="10" stroke-linecap="square" fill="none"></path>',
  };

  /**
   * Fallback for an agent the plugin has no icon for yet: a plain bot, wider
   * and squatter than the `robot` heads above so it reads as "no role matched"
   * rather than as one of the roles.
   *
   * Icon: sharp/bot.
   */
  const FALLBACK =
    '<path d="M15 3L19 3L21 8L21 10" stroke="currentColor" stroke-width="2" stroke-miterlimit="10" data-color="color-2" fill="none"></path> <path d="M12 3L5 3L3 8L3 10" stroke="currentColor" stroke-width="2" stroke-miterlimit="10" data-color="color-2" fill="none"></path> <path d="M21 21L3 21L3 9L21 9L21 21Z" stroke="currentColor" stroke-width="2" stroke-miterlimit="10" data-color="color-2" fill="none"></path> <path d="M12 5V1" stroke="currentColor" stroke-width="2" stroke-linecap="square" fill="none"></path> <path d="M9 16V14" stroke="currentColor" stroke-width="2" stroke-linecap="square" fill="none"></path> <path d="M15 16V14" stroke="currentColor" stroke-width="2" stroke-linecap="square" fill="none"></path>';

  /**
   * Builds the inline `<svg>` for `agent`, ready to insert.
   *
   * A dynamic councillor (`councillor-gpt`, …) is treated as a councillor,
   * which mirrors how the original companion collapsed those onto one
   * animation.
   */
  window.agentIcon = (agent) => {
    const body =
      ICON_BODIES[agent] ??
      (agent?.startsWith('councillor-') ? ICON_BODIES.councillor : undefined);
    return `<svg viewBox="${VIEW_BOX}" fill="none" aria-hidden="true">${
      body ?? FALLBACK
    }</svg>`;
  };
})();

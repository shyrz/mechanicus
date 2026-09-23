/**
 * Nucleo icon bodies, one per agent role.
 *
 * Icons are inlined rather than fetched: the webview is offline and the bundle
 * has no asset pipeline, so the markup ships with the source.
 *
 * These are the raw `<svg>` bodies from the `core` family, outline, 24px. They
 * carry Nucleo's own customization hooks, which is why they are pasted verbatim
 * instead of normalized:
 *
 * - `stroke="currentColor"` — the button sets the colour, so the icon follows.
 * - `stroke-width="var(--nucleo-stroke-width, 2)"` — the one stroke knob Nucleo
 *   exposes for core outline icons.
 * - `data-color="color-2"` — the parts meant to take a secondary colour. At
 *   this size the glyph is single-colour, so nothing sets it; the hooks are
 *   kept so a two-tone treatment stays a CSS change.
 *
 * Corners are the family default (square). The mark is 24px on a ~28px button,
 * where square caps read as deliberate rather than sharp.
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
    omnissiah:
      '<path d="M2.5 15H21.5" stroke="currentColor" stroke-width="var(--nucleo-stroke-width, 2)" data-color="color-2" data-cap="butt" fill="none"></path> <path d="M17 9.78125L22 6.1875L21.144 17.1556C21.0627 18.1967 20.1942 19 19.15 19H4.84998C3.80577 19 2.9373 18.1967 2.85605 17.1556L2 6.1875L7 9.78125L12 3L17 9.78125Z" stroke="currentColor" stroke-width="var(--nucleo-stroke-width, 2)" stroke-miterlimit="10" stroke-linecap="square" fill="none"></path>',
    // Codebase navigation: find the file, find the symbol.
    magos:
      '<line x1="20.5" y1="20.5" x2="15" y2="15" fill="none" stroke="currentColor" stroke-linecap="square" stroke-miterlimit="10" stroke-width="var(--nucleo-stroke-width, 2)" data-color="color-2"></line><circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-linecap="square" stroke-miterlimit="10" stroke-width="var(--nucleo-stroke-width, 2)"></circle>',
    // Research across code and documentation.
    logis:
      '<line x1="12" y1="6" x2="12" y2="21" fill="none" stroke="currentColor" stroke-miterlimit="10" stroke-width="var(--nucleo-stroke-width, 2)" data-color="color-2" data-cap="butt"></line><path d="m17.5,3c-3,0-5.5,1.3-5.5,3,0-1.7-2.5-3-5.5-3S1,4.3,1,6v15c0-1.7,2.5-3,5.5-3s5.5,1.3,5.5,3c0-1.7,2.5-3,5.5-3s5.5,1.3,5.5,3V6c0-1.7-2.5-3-5.5-3Z" fill="none" stroke="currentColor" stroke-linecap="square" stroke-miterlimit="10" stroke-width="var(--nucleo-stroke-width, 2)"></path>',
    // Strategic advice and review: judgement, not action.
    dominus:
      '<path d="M8 17.7131L8.49996 23H15.5L16 17.7131" stroke="currentColor" stroke-width="var(--nucleo-stroke-width, 2)" stroke-miterlimit="10" fill="none" data-cap="butt"></path> <path d="M12 19C15.866 19 19 15.866 19 12C19 8.13401 15.866 5 12 5C8.13401 5 5 8.13401 5 12C5 15.866 8.13401 19 12 19Z" stroke="currentColor" stroke-width="var(--nucleo-stroke-width, 2)" stroke-miterlimit="10" stroke-linecap="square" fill="none"></path> <path d="M12 1V1.01" stroke="currentColor" stroke-width="var(--nucleo-stroke-width, 2)" stroke-miterlimit="10" stroke-linecap="square" data-color="color-2" fill="none"></path> <path d="M23.005 12.005L22.995 12.005" stroke="currentColor" stroke-width="var(--nucleo-stroke-width, 2)" stroke-miterlimit="10" stroke-linecap="square" data-color="color-2" fill="none"></path> <path d="M0.994995 12.005L1.005 12.005" stroke="currentColor" stroke-width="var(--nucleo-stroke-width, 2)" stroke-miterlimit="10" stroke-linecap="square" data-color="color-2" fill="none"></path> <path d="M19.7817 4.2233L19.7747 4.23037" stroke="currentColor" stroke-width="var(--nucleo-stroke-width, 2)" stroke-miterlimit="10" stroke-linecap="square" data-color="color-2" fill="none"></path> <path d="M4.21826 4.22327L4.22533 4.23034" stroke="currentColor" stroke-width="var(--nucleo-stroke-width, 2)" stroke-miterlimit="10" stroke-linecap="square" data-color="color-2" fill="none"></path>',
    // UI/UX: craft the interface.
    artisan:
      '<path d="M5.48523 7.36401L12.5563 1.70716L14.3241 3.47493L13.617 7.01046L17.1525 6.30335L22.4558 11.6067L16.7989 18.6777" stroke="currentColor" stroke-width="var(--nucleo-stroke-width, 2)" data-color="color-2" data-cap="butt" fill="none"></path> <path d="M4.56198 8.28739L5.48528 7.36408L16.799 18.6778L15.8757 19.6011C15.1844 20.2924 14.0946 20.3826 13.299 19.8143L9.72792 17.2636L6.62 21.2595C5.642 22.5169 3.78326 22.6326 2.65685 21.5062C1.53045 20.3798 1.64617 18.5211 2.90359 17.5431L6.89949 14.4352L4.34873 10.8641C3.78046 10.0685 3.87066 8.97871 4.56198 8.28739Z" stroke="currentColor" stroke-width="var(--nucleo-stroke-width, 2)" stroke-linecap="square" fill="none"></path>',
    // Focused implementation: build and repair.
    genetor:
      '<path d="m11.373,9.479l-8.437,7.593c-1.204,1.083-1.253,2.955-.108,4.1,1.156,1.156,3.049,1.093,4.126-.136l7.413-8.465" fill="none" stroke="currentColor" stroke-miterlimit="10" stroke-width="var(--nucleo-stroke-width, 2)" data-color="color-2" data-cap="butt"></path><path d="m18.164,8.664l-2.828-2.828,3.372-3.372c-.676-.297-1.422-.464-2.207-.464-3.038,0-5.5,2.462-5.5,5.5s2.462,5.5,5.5,5.5,5.5-2.462,5.5-5.5c0-.786-.167-1.531-.464-2.207l-3.372,3.372Z" fill="none" stroke="currentColor" stroke-linecap="square" stroke-miterlimit="10" stroke-width="var(--nucleo-stroke-width, 2)"></path>',
    // Visual analysis: read images, screenshots, diagrams.
    observer:
      '<circle cx="12" cy="10" r="5" fill="none" stroke="currentColor" stroke-linecap="square" stroke-miterlimit="10" stroke-width="var(--nucleo-stroke-width, 2)" data-color="color-2"></circle><path d="m1.141,12s3.859-7,10.859-7,10.859,7,10.859,7c0,0-3.859,7-10.859,7S1.141,12,1.141,12Z" fill="none" stroke="currentColor" stroke-linecap="square" stroke-miterlimit="10" stroke-width="var(--nucleo-stroke-width, 2)"></path>',
    // Synthesis across models: several voices, one answer.
    council:
      '<circle cx="16.5" cy="4.75" r="2.75" fill="none" stroke="currentColor" stroke-linecap="square" stroke-miterlimit="10" stroke-width="var(--nucleo-stroke-width, 2)" data-color="color-2"></circle><path d="m15.553,16.5h6.422c.015-.165.025-.331.025-.5,0-3.038-2.462-5.5-5.5-5.5-.825,0-1.604.187-2.306.512" fill="none" stroke="currentColor" stroke-linecap="square" stroke-miterlimit="10" stroke-width="var(--nucleo-stroke-width, 2)" data-color="color-2"></path><circle cx="7.5" cy="10.25" r="2.75" fill="none" stroke="currentColor" stroke-linecap="square" stroke-miterlimit="10" stroke-width="var(--nucleo-stroke-width, 2)"></circle><path d="m12.975,22c.015-.165.025-.331.025-.5,0-3.038-2.462-5.5-5.5-5.5s-5.5,2.462-5.5,5.5c0,.169.01.335.025.5h10.95Z" fill="none" stroke="currentColor" stroke-linecap="square" stroke-miterlimit="10" stroke-width="var(--nucleo-stroke-width, 2)"></path>',
    // One independent analysis among the council.
    councillor:
      '<circle cx="12" cy="6" r="4" fill="none" stroke="currentColor" stroke-linecap="square" stroke-miterlimit="10" stroke-width="var(--nucleo-stroke-width, 2)" data-color="color-2"></circle><path d="m12,13c-4.418,0-8,3.582-8,8,5.333,1.333,10.667,1.333,16,0,0-4.418-3.582-8-8-8Z" fill="none" stroke="currentColor" stroke-linecap="square" stroke-miterlimit="10" stroke-width="var(--nucleo-stroke-width, 2)"></path>',
    // Idle / no agent yet: the mark of the machine itself.
    intro:
      '<path d="M17.85 15.15L16.5 12L15.15 15.15L12 16.5L15.15 17.85L16.5 21L17.85 17.85L21 16.5L17.85 15.15Z" stroke="currentColor" stroke-width="var(--nucleo-stroke-width, 2)" data-cap="butt" fill="none"></path> <path d="M8.85 6.15L7.5 3L6.15 6.15L3 7.5L6.15 8.85L7.5 12L8.85 8.85L12 7.5L8.85 6.15Z" stroke="currentColor" stroke-width="var(--nucleo-stroke-width, 2)" data-cap="butt" fill="none"></path> <path d="M20.2 3.8L19 1L17.8 3.8L15 5L17.8 6.2L19 9L20.2 6.2L23 5L20.2 3.8Z" fill="currentColor" data-color="color-2" data-cap="butt" data-stroke="none"></path> <path d="M6.2 17.8L5 15L3.8 17.8L1 19L3.8 20.2L5 23L6.2 20.2L9 19L6.2 17.8Z" fill="currentColor" data-color="color-2" data-cap="butt" data-stroke="none"></path>',
    // Waiting on the user: an agent, not a person.
    input:
      '<path d="M7 4V2" stroke="currentColor" stroke-width="var(--nucleo-stroke-width, 2)" stroke-linecap="square" data-color="color-2" fill="none"></path> <path d="M7 22V20" stroke="currentColor" stroke-width="var(--nucleo-stroke-width, 2)" stroke-linecap="square" data-color="color-2" fill="none"></path> <path d="M17 4V2" stroke="currentColor" stroke-width="var(--nucleo-stroke-width, 2)" stroke-linecap="square" data-color="color-2" fill="none"></path> <path d="M17 22V20" stroke="currentColor" stroke-width="var(--nucleo-stroke-width, 2)" stroke-linecap="square" data-color="color-2" fill="none"></path> <path d="M12 4V2" stroke="currentColor" stroke-width="var(--nucleo-stroke-width, 2)" stroke-linecap="square" data-color="color-2" fill="none"></path> <path d="M12 22V20" stroke="currentColor" stroke-width="var(--nucleo-stroke-width, 2)" stroke-linecap="square" data-color="color-2" fill="none"></path> <path d="M20 7L22 7" stroke="currentColor" stroke-width="var(--nucleo-stroke-width, 2)" stroke-linecap="square" data-color="color-2" fill="none"></path> <path d="M2 7L4 7" stroke="currentColor" stroke-width="var(--nucleo-stroke-width, 2)" stroke-linecap="square" data-color="color-2" fill="none"></path> <path d="M20 17L22 17" stroke="currentColor" stroke-width="var(--nucleo-stroke-width, 2)" stroke-linecap="square" data-color="color-2" fill="none"></path> <path d="M2 17L4 17" stroke="currentColor" stroke-width="var(--nucleo-stroke-width, 2)" stroke-linecap="square" data-color="color-2" fill="none"></path> <path d="M20 12L22 12" stroke="currentColor" stroke-width="var(--nucleo-stroke-width, 2)" stroke-linecap="square" data-color="color-2" fill="none"></path> <path d="M2 12L4 12" stroke="currentColor" stroke-width="var(--nucleo-stroke-width, 2)" stroke-linecap="square" data-color="color-2" fill="none"></path> <path d="M18 4H6C4.89543 4 4 4.89543 4 6V18C4 19.1046 4.89543 20 6 20H18C19.1046 20 20 19.1046 20 18V6C20 4.89543 19.1046 4 18 4Z" stroke="currentColor" stroke-width="var(--nucleo-stroke-width, 2)" stroke-miterlimit="10" stroke-linecap="square" fill="none"></path> <path d="M13.5 10.5L12 7L10.5 10.5L7 12L10.5 13.5L12 17L13.5 13.5L17 12L13.5 10.5Z" fill="currentColor" data-color="color-2" data-cap="butt" data-stroke="none"></path>',
  };

  /** Fallback for an agent the plugin has no icon for yet. */
  const FALLBACK = ICON_BODIES.input;

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

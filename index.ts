// Root entry for local development loading.
//
// OpenCode resolves a directory plugin entry by looking for an index file
// in the plugin directory. This re-export lets the repo root act as the
// plugin target:
//
//   ~/.config/opencode/opencode.jsonc -> "plugins": ["/Users/shyrz/Dev/mechanicus"]
//
// Bun loads TypeScript directly, so local dev changes take effect on the
// next opencode restart without running `bun run build`.
// Built-package consumers keep using package.json "main"/"exports" (dist/).
export { default } from './src/index';

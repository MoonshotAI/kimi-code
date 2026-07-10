// Vite-style `?raw` imports are used inside kimi-code sources (e.g. agent-core
// imports `*.md?raw` / `*.yaml?raw`). The desktop typecheck resolves kimi-code
// via `workspace:^` exports straight to its `src`, so it needs this ambient
// declaration even though the desktop itself never imports raw assets.
declare module '*?raw' {
  const content: string;
  export default content;
}

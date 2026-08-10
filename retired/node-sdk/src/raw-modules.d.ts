// Raw-string imports for prompt/profile sources. Vite/Vitest handles `?raw`
// natively; tsdown uses the shared `raw-text-plugin` for the same import shape.
// Local replacement for the retired agent-core `prompt-modules.d.ts`.

declare module '*?raw' {
  const content: string;
  export default content;
}

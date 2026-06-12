// Raw-string imports for prompt sources. Vite/Vitest handles `?raw` natively;
// tsdown uses the shared `raw-text-plugin` for the same import shape.

declare module '*?raw' {
  const content: string;
  export default content;
}

// Raw-string imports for prompt sources. Vite/Vitest handles `?raw` natively.

declare module '*?raw' {
  const content: string;
  export default content;
}

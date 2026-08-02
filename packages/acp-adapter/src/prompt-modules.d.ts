// Raw-string imports for prompt sources. Vite/Vitest handles `?raw` natively;
// tsdown uses the shared `raw-text-plugin` for the same import shape.
//
// Local copy of the retired `@moonshot-ai/agent-core` shim
// (`packages/agent-core/src/prompt-modules.d.ts`). Retained here while
// `@moonshot-ai/kimi-code-sdk` still re-exports the v1 engine's source (which
// imports `*.md?raw` prompts); it becomes a harmless no-op once the SDK is
// unbound.

declare module '*?raw' {
  const content: string;
  export default content;
}

# @moonshot-ai/app-markdown

Chat Markdown renderer for the Kimi web UI. Wraps [`markstream-vue`](https://www.npmjs.com/package/markstream-vue) (smooth streaming + shiki code blocks) and wires up KaTeX display math, Mermaid diagrams, and a local ` ```diff ` renderer, all skinned to the Terminal Pro design tokens.

Source-only package: `exports` points at `./src/*`, so the **consumer's** bundler transpiles the Vue SFC, the markstream-vue CSS imports, and the `?worker` imports.

## Exports

- `Markdown` — the renderer component (default export of `./Markdown.vue`).

## Props

- `text: string` (required) — markdown source.
- `streaming?: boolean` — `true` only for the assistant turn that is actively streaming; drives both `final` and markstream's smooth-streaming.
- `openFile?: (target: { path: string; line?: number }) => void` — called when the user clicks a workspace file path or a local link detected in the content.

## Consumer requirements

The host app must:

1. **Install the locked renderer deps.** `markstream-vue` and `stream-markdown` (which transitively pull `shiki`, `katex`, and `mermaid`) at the same versions pinned in `apps/web`. The renderer calls `enableKatex()` / `enableMermaid()` at module scope and imports `markstream-vue/index.px.css` and `katex/dist/katex.min.css` itself.

2. **Use ES-format workers.** The renderer instantiates markstream's off-thread KaTeX/Mermaid workers via `import … from 'markstream-vue/workers/*?worker&type=module'`. Mermaid's per-diagram dynamic imports need code-splitting, so the consumer's Vite config must set:
   ```ts
   // vite.config.ts
   export default defineConfig({
     worker: { format: 'es' },
   });
   ```
   (`apps/web/vite.config.ts` already does.)

3. **Provide an image resolver.** Local image `src`s (attachments / chat images) are rewritten before markstream sees them:
   ```ts
   app.provide('resolveImage', (src: string) => Promise<string>);
   ```
   Return a loadable URL (e.g. a data URL) for a local path, or the original `src` to leave it untouched. The component injects `'resolveImage'`; if absent, local images are left as-is.

4. **Colour scheme.** The renderer reads the host's dark mode directly from `@moonshot-ai/app-core`'s `useIsDark()` singleton (resolved against `<html data-color-scheme>`), so no `provide` bridge is required. It falls back to light when the document carries no scheme.

5. **Load the design tokens.** Import `@moonshot-ai/app-ui/style.css` and set `<html data-color-scheme="light|dark|system">` — the skin reads `var(--color-*)`, `var(--font-*)`, `var(--radius-*)`, etc.

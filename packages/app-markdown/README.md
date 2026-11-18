# @moonshot-ai/app-markdown

Chat Markdown renderer for the Kimi web UI. Wraps [`markstream-vue`](https://www.npmjs.com/package/markstream-vue) (smooth streaming + shiki code blocks) and wires up KaTeX display math, Mermaid diagrams, and a local ` ```diff ` renderer, styled with the independent Markdown design tokens.

Source-only package: `exports` points at `./src/*`, so the **consumer's** bundler transpiles the Vue SFC, the markstream-vue CSS imports, and the `?worker` imports.

## Exports

- `Markdown` — the renderer component (default export of `./Markdown.vue`).

## Props

- `text: string` (required) — markdown source.
- `streaming?: boolean` — `true` only for the assistant turn that is actively streaming; drives both `final` and markstream's smooth-streaming.
- `openFile?: (target: { path: string; line?: number }) => void` — called when the user clicks a workspace file path or a local link detected in the content.

## Consumer requirements

The host app must:

1. **Install the locked renderer deps.** `markstream-vue@2.0.19` and its code-block runtimes are declared by this package; desktop and web do not need duplicate renderer declarations. Runtime and direct parser tests resolve the same `stream-markdown-parser@1.2.20`. The renderer calls `enableKatex()` / `enableMermaid()` at module scope and imports `markstream-vue/index.px.css` and `katex/dist/katex.min.css` itself.

2. **Use ES-format workers.** The renderer instantiates markstream's off-thread KaTeX/Mermaid workers via `import … from 'markstream-vue/workers/*?worker&type=module'`. Mermaid's per-diagram dynamic imports need code-splitting, so the consumer's Vite config must set:
   ```ts
   // vite.config.ts
   export default defineConfig({
     worker: { format: 'es' },
   });
   ```
   (`apps/desktop/vite.web.config.ts` already does.)

3. **Provide an image resolver.** Local image `src`s (attachments / chat images) are rewritten before markstream sees them:
   ```ts
   import { ResolveImageKey } from '@moonshot-ai/app-core/contracts';

   app.provide(ResolveImageKey, (src: string) => Promise<string>);
   ```
   Return a loadable URL (e.g. a data URL) for a local path, or the original `src` to leave it untouched. The component injects `ResolveImageKey` (from `@moonshot-ai/app-core/contracts`, alongside the `ResolveImage` interface); if absent, local images are left as-is.

4. **Colour scheme.** The renderer reads the host's dark mode directly from `@moonshot-ai/app-core`'s `useIsDark()` singleton (resolved against `<html data-color-scheme>`), so no `provide` bridge is required. It falls back to light when the document carries no scheme.

5. **Load the design tokens.** Import `@moonshot-ai/app-ui/style.css` and set `<html data-color-scheme="light|dark|system">` — the content skin reads `--markdown-*` tokens. Typography retains the existing product fonts. The token source is [`@moonshot-ai/app-ui/src/markdown-tokens.css`](../app-ui/src/markdown-tokens.css).

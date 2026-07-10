import type { InjectionKey, Ref } from 'vue';

// Bridges the host app's colour scheme into the Markdown renderer without a
// reverse dependency on the host. The host provides a reactive `Ref<boolean>`
// (its colour-scheme singleton); the renderer injects it to switch shiki
// between `github-light` / `github-dark` and to theme KaTeX / Mermaid. When the
// host does not provide it, the renderer falls back to light. (Once that
// colour-scheme composable moves into `@moonshot-ai/web-core` in phase 3.4, the
// renderer will import it directly and this bridge — along with the host's
// `provide` — will be removed.)
export const IsDarkKey: InjectionKey<Ref<boolean>> = Symbol('IsDark');

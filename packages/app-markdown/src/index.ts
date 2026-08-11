// @moonshot-ai/app-markdown — chat Markdown renderer (markstream-vue) with
// KaTeX / Mermaid / Shiki workers. Source-only package: the consumer's bundler
// transpiles these (`exports` points at ./src/*), so the `?worker` imports and
// markstream-vue CSS are resolved by the consumer's Vite config.

export { default as Markdown } from './Markdown.vue';

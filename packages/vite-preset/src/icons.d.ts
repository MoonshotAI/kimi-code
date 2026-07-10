// unplugin-icons `?raw` imports — `unplugin-icons/types/vue` declares
// `~icons/*` as a Vue FunctionalComponent (for direct component imports). The
// `?raw` query re-exports the raw SVG source, which must type as `string`;
// this more-specific pattern overrides the component declaration for `?raw`
// imports only (e.g. `~icons/ri/add-line?raw`), leaving component imports
// (`~icons/ri/add-line`) typed as components.
declare module '~icons/*?raw' {
  const src: string;
  export default src;
}

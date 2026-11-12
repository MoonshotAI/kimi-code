/**
 * Ambient declaration for `?raw` imports, which load a file's text content as a default-exported string.
 */

declare module '*?raw' {
  const content: string;
  export default content;
}

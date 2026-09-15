/**
 * Shared Markdown behavior options (distinct from the visual theme).
 *
 * Holds the process-wide LaTeX toggle from tui.toml so transcript components
 * don't each need the config threaded through construction. Mirrors the
 * render-cache toggle pattern (see utils/render-cache.ts).
 */

import type { MarkdownOptions } from '@moonshot-ai/pi-tui';

// Default on, matching upstream pi-tui; overridden from tui.toml at startup
// and on /reload.
let renderLatex = true;

export function setMarkdownRenderLatex(value: boolean): void {
  renderLatex = value;
}

export function createMarkdownOptions(): MarkdownOptions {
  return { renderLatex };
}

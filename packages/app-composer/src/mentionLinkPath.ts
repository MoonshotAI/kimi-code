/**
 * Resolve a mention-pill link href to the workspace path it points at.
 *
 * The composer serializes mention hrefs as RAW paths — its one concession to
 * URL-encoding is '%' → '%25', so a literal percent in a real filename
 * (`report%20final.md`, on the wire `report%2520final.md`) survives the
 * decode below losslessly. `#`/`?` are legitimate filename characters
 * (`docs/a#b.md`) and must NOT be stripped as fragment/query. Markdown
 * rendering itself percent-encodes spaces and non-ASCII characters in hrefs
 * (`my file.md` → `my%20file.md`), so decode them back to the real filesystem
 * path. A malformed `%` sequence (hand-written markdown) makes
 * decodeURIComponent throw — fall back to the raw href, which is the best
 * guess at the intended path.
 *
 * This is the DISPLAY path (dataset.mentionPath, tooltip, copy). Action sites
 * (click-to-open, existence probe) additionally strip an UNENCODED `#`/`?`
 * tail so chat links like `[Usage](README.md#usage)` open the file, not a
 * path with the anchor glued on — see `mentionActionPath` in this package's
 * composerTextDoc (single-sourced there next to classifyMentionHref).
 */
export function mentionHrefToPath(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

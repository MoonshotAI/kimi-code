import { classifyMentionHref, mentionActionPath, mentionHrefToPath } from '@moonshot-ai/app-composer';

/**
 * Click routing for RAW markdown links while a turn is still streaming.
 *
 * Settled turns never need this: processMarkdownLinks (Markdown.vue) rewrites
 * every local-path link into a mention pill — the href is removed and the
 * click is routed to openFile. That rewrite is skipped mid-stream because
 * markstream keeps rebuilding the DOM, so a streaming message's links stay
 * plain <a href> elements and a click becomes a DEFAULT navigation. For a
 * relative workspace path that navigation resolves against the page URL and
 * dies on the server: kap-server's webAssets route and the desktop app://
 * protocol handler both serve an SPA fallback only for EXTENSIONLESS paths,
 * so `src/foo.ts` 404s with a plain "not found" body that replaces the whole
 * app — and reloading just 404s again, since the address bar now holds the
 * bad URL (on desktop there is no address bar to fix it with).
 *
 * The fix is a delegated listener on the markdown root (it survives DOM
 * rebuilds precisely because it never touches the anchors) that consults
 * this pure function and either routes the click or swallows it. Routing
 * deliberately reuses the same mention classification as the settled pill
 * path so a link behaves the same before and after the turn settles.
 */
export type StreamingLinkAction =
  /** Local file link on a host that can preview: fire openFile with the same
   *  action path the settled pill would use. */
  | { type: 'open-file'; path: string }
  /** External web link: open in a new window (desktop's windowOpenHandler
   *  reroutes that to the system browser). */
  | { type: 'open-external'; url: string }
  /** In-page anchor: keep the browser default (scroll, no navigation). */
  | { type: 'passthrough' }
  /** Everything else: swallow. A dead click for the seconds a turn streams
   *  beats a navigation that can 404 the whole app. */
  | { type: 'swallow' };

export function streamingLinkAction(href: string, canOpenFile: boolean): StreamingLinkAction {
  // In-page anchors ([x](#section)) only scroll — no navigation to guard.
  if (href.startsWith('#')) return { type: 'passthrough' };

  const kind = classifyMentionHref(href);
  if (kind !== null) {
    // Mirror the settled pill's click: strip an unencoded #/? tail on the raw
    // href, then decode ([Usage](README.md#usage) opens README.md). Folder and
    // skill pills are inert even once settled, and a host without openFile
    // (UpdateIndicator, QuestionCard) has no file target — swallow them all.
    if (kind === 'file' && canOpenFile) {
      return { type: 'open-file', path: mentionHrefToPath(mentionActionPath(href)) };
    }
    return { type: 'swallow' };
  }

  // classifyMentionHref already ruled out every schemed/protocol-relative/
  // query-only href as non-local, so only plain external web links remain
  // routable. Opening them in a new window also fixes the same-tab app
  // replacement a raw external link would otherwise cause mid-stream.
  if (/^https?:\/\//i.test(href)) return { type: 'open-external', url: href };

  // mailto:/vscode:/tel:, protocol-relative //host/path, query-only ?page=2,
  // empty hrefs: none are safe to navigate to from a streaming surface.
  return { type: 'swallow' };
}

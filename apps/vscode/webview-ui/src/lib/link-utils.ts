import { defaultUrlTransform } from "react-markdown";

/**
 * Markdown link hrefs → local file-link targets for the chat webview.
 *
 * VS Code webviews only follow http(s)/external anchors, so links the
 * assistant emits against local files (plain paths, `file://` or
 * `vscode://file/` URIs, optionally with a trailing `:line(:col)` suffix)
 * must be routed through the extension host instead of an `<a>` element.
 * Kept free of webview service imports so node-env unit tests can exercise
 * it directly.
 */

export interface FileLinkTarget {
  readonly path: string;
  readonly line?: number;
}

const EXTERNAL_SCHEME = /^(?:https?|mailto|data|blob|javascript|vscode-webview):/i;
const FILE_URI = /^file:\/\//i;
const VSCODE_FILE_URI = /^vscode:\/\/file/i;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
const OTHER_SCHEME = /^[A-Za-z][\w+.-]*:/;
// A trailing `:line` or `:line:column` suffix (e.g. `src/app.ts:33`).
const LINE_SUFFIX = /:(\d+)(?::\d+)?$/;

export function parseFileLink(href: string | undefined): FileLinkTarget | null {
  if (!href || href.startsWith("#")) return null;

  let raw = href;
  if (FILE_URI.test(raw)) {
    // `file:///C:/x` keeps `/C:/x` after the scheme — drop the extra slash.
    raw = raw.replace(FILE_URI, "").replace(/^\/(?=[A-Za-z]:[\\/])/, "");
  } else if (VSCODE_FILE_URI.test(raw)) {
    raw = raw.replace(VSCODE_FILE_URI, "");
  } else if (EXTERNAL_SCHEME.test(raw)) {
    return null;
  } else if (OTHER_SCHEME.test(raw) && !WINDOWS_DRIVE.test(raw)) {
    // Any other scheme (except a Windows drive prefix) is not a file link.
    return null;
  } else if (raw.startsWith("//")) {
    // Protocol-relative URL; a UNC path arrives with backslashes instead.
    return null;
  }

  try {
    // Markdown destinations are percent-encoded; a literal `%` in a path is
    // far rarer than an encoded space, so decoding wins on balance.
    raw = decodeURIComponent(raw);
  } catch {
    // Malformed escape: keep the text as written.
  }

  const lineMatch = LINE_SUFFIX.exec(raw);
  const path = lineMatch === null ? raw : raw.slice(0, lineMatch.index);
  if (!path) return null;
  return lineMatch === null ? { path } : { path, line: Number.parseInt(lineMatch[1], 10) };
}

/**
 * react-markdown's default sanitizer empties every href outside its
 * http(s)/mailto allow-list, which would drop `file://` and `vscode://file/`
 * links before the anchor renderer can route them — pass those through
 * verbatim and defer to the default transform for everything else.
 */
export function fileAwareUrlTransform(url: string): string {
  // A native Windows drive prefix would also be read as an unknown protocol
  // by the default transform and emptied — preserve it alongside the URIs.
  if (FILE_URI.test(url) || VSCODE_FILE_URI.test(url) || WINDOWS_DRIVE.test(url)) return url;
  return defaultUrlTransform(url);
}

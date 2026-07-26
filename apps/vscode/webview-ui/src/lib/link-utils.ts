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
  } else if (raw.startsWith("//")) {
    // Protocol-relative URL; a UNC path arrives with backslashes instead.
    return null;
  } else if (OTHER_SCHEME.test(raw.replace(LINE_SUFFIX, "")) && !WINDOWS_DRIVE.test(raw)) {
    // Any other scheme is not a file link — but strip a trailing `:line`
    // suffix before the test, or a root-level path like `README.md:5` would
    // read as a protocol. Windows drive prefixes are paths, never schemes.
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
  if (lineMatch !== null) {
    const line = Number.parseInt(lineMatch[1], 10);
    const path = raw.slice(0, lineMatch.index);
    // Line references are 1-based; a `:0` suffix is kept as part of the path.
    if (line >= 1) {
      return path ? { path, line } : null;
    }
  }
  return raw ? { path: raw } : null;
}

/**
 * react-markdown's default sanitizer empties every URL it reads as an
 * unknown protocol — which covers `file://`, `vscode://file/`, Windows drive
 * prefixes, and even root-level relative paths with a `:line` suffix
 * (`README.md:5`), all before the anchor renderer could route them. Preserve
 * exactly what `parseFileLink` accepts, and only for anchor hrefs: other URL
 * attributes (image/media `src`) keep the default sanitizer behavior.
 */
export function fileAwareUrlTransform(url: string, key = "href"): string {
  if (key === "href" && parseFileLink(url) !== null) return url;
  return defaultUrlTransform(url);
}

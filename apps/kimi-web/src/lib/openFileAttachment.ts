// apps/kimi-web/src/lib/openFileAttachment.ts
// Open a generic file attachment in a new tab — but ONLY types the browser
// renders inertly (the whitelist below). A blob: URL inherits this origin, so
// navigating a tab to an active document (HTML/SVG/JS/XML) would execute its
// scripts with the app's credentials (the daemon token lives in localStorage)
// and a live window.opener. Bytes come through the API client with auth — a
// bare getFileUrl src 401s under daemon auth.

import { getKimiWebApi } from '../api';

// Navigating to these types cannot execute content: the PDF viewer is
// sandboxed, media elements don't run scripts, and these image formats can't
// carry any (SVG can — it is excluded on purpose).
const SAFE_PREVIEW_MIME_RE =
  /^(application\/pdf|image\/(png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)|video\/[\w.+-]+|audio\/[\w.+-]+)$/i;

// Everything under text/ renders as source when forced to text/plain — EXCEPT
// text/html, which is an active document. When the recorded MIME is empty or
// untrusted-looking, these extensions still preview, always as text/plain.
const TEXT_PREVIEW_EXT_RE =
  /^(txt|md|markdown|log|json|ya?ml|csv|tsv|ts|mts|tsx|jsx|css|py|go|rs|java|c|h|cc|cpp|hpp|sh|zsh|sql|toml|ini|cfg|conf|vue)$/i;
const IMAGE_PREVIEW_EXT_RE = /^(png|jpe?g|gif|webp|avif|bmp|ico)$/i;

const TEXT_PLAIN = 'text/plain;charset=utf-8';

export type OpenFileAttachmentResult = 'previewed' | 'unsupported' | 'failed';

/**
 * The MIME to stamp on the preview blob when this attachment may open in a
 * tab, or null when it must never be previewed. The returned MIME always
 * comes from the whitelist — for text it is pinned to text/plain — so the
 * navigation stays inert no matter what content-type was recorded at upload.
 */
function safePreviewMime(name: string | undefined, mediaType: string | undefined): string | null {
  const mime = (mediaType ?? '').toLowerCase();
  if (SAFE_PREVIEW_MIME_RE.test(mime)) return mime;
  if (mime.startsWith('text/')) return mime === 'text/html' ? null : TEXT_PLAIN;
  const ext = name?.match(/\.([A-Za-z0-9]{1,8})$/)?.[1]?.toLowerCase();
  if (ext === undefined) return null;
  if (TEXT_PREVIEW_EXT_RE.test(ext)) return TEXT_PLAIN;
  if (IMAGE_PREVIEW_EXT_RE.test(ext)) return `image/${ext === 'jpg' ? 'jpeg' : ext === 'ico' ? 'x-icon' : ext}`;
  if (ext === 'pdf') return 'application/pdf';
  return null;
}

/**
 * Preview a whitelisted file attachment in a new tab; anything else reports
 * 'unsupported' so the caller can tell the user the type can't be opened.
 * The tab is opened synchronously with the click (popup blockers reject
 * window.open after an await), and a blocked popup falls back to a download.
 */
export async function openFileAttachment(
  fileId: string,
  name?: string,
  mediaType?: string,
): Promise<OpenFileAttachmentResult> {
  const previewMime = safePreviewMime(name, mediaType);
  if (previewMime === null) return 'unsupported';
  // noopener can't go into window.open — it forfeits the handle we need to
  // navigate after the async fetch. Sever the opener right away instead; the
  // whitelist is what actually keeps the new tab inert.
  const win = window.open('', '_blank');
  if (win !== null) win.opener = null;
  const blob = await getKimiWebApi().getFileBlob(fileId).catch(() => null);
  if (blob === null) {
    win?.close();
    return 'failed';
  }
  const url = URL.createObjectURL(new Blob([blob], { type: previewMime }));
  if (win !== null) {
    win.location.href = url;
  } else {
    const a = document.createElement('a');
    a.href = url;
    a.download = name ?? fileId;
    a.click();
  }
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 60_000);
  return 'previewed';
}

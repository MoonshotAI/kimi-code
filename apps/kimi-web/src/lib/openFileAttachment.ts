// apps/kimi-web/src/lib/openFileAttachment.ts
// Open a generic file attachment: preview in a new tab when the browser can
// render the type (pdf / text / image / video / audio), otherwise download
// with the original name. Bytes come through the API client with auth — a
// bare getFileUrl src 401s under daemon auth.

import { getKimiWebApi } from '../api';

const PREVIEWABLE_EXT =
  /^(pdf|txt|md|markdown|log|json|ya?ml|xml|csv|tsv|html?|js|mjs|ts|mts|tsx|jsx|css|py|go|rs|java|c|h|cc|cpp|hpp|sh|zsh|sql|toml|ini|cfg|conf|vue)$/i;

function isPreviewable(name: string | undefined, mediaType: string | undefined): boolean {
  if (mediaType !== undefined && mediaType.length > 0) {
    const mime = mediaType.toLowerCase();
    if (
      mime.startsWith('text/') ||
      mime.startsWith('image/') ||
      mime.startsWith('video/') ||
      mime.startsWith('audio/')
    ) {
      return true;
    }
    if (mime === 'application/pdf' || mime === 'application/json') return true;
  }
  const ext = name?.match(/\.([A-Za-z0-9]{1,8})$/)?.[1];
  return ext !== undefined && PREVIEWABLE_EXT.test(ext);
}

/**
 * Open a file attachment identified by its daemon file id. Previews open in a
 * new tab; anything else downloads. The tab is opened synchronously with the
 * click (popup blockers reject window.open after an await), and a blocked
 * popup falls back to a download. Failures are silent: nothing actionable to
 * show beyond the missing preview.
 */
export async function openFileAttachment(
  fileId: string,
  name?: string,
  mediaType?: string,
): Promise<void> {
  const previewable = isPreviewable(name, mediaType);
  const win = previewable ? window.open('', '_blank') : null;
  const blob = await getKimiWebApi().getFileBlob(fileId).catch(() => null);
  if (blob === null) {
    win?.close();
    return;
  }
  const url = URL.createObjectURL(blob);
  if (previewable && win !== null) {
    win.location.href = url;
  } else {
    const a = document.createElement('a');
    a.href = url;
    a.download = name ?? fileId;
    a.click();
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

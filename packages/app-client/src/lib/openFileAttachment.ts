
import type { KimiWebApi } from '@moonshot-ai/app-core/api';

const SAFE_PREVIEW_MIME_RE =
  /^(application\/pdf|image\/(png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)|video\/[\w.+-]+|audio\/[\w.+-]+)$/i;

const TEXT_PREVIEW_EXT_RE =
  /^(txt|md|markdown|log|json|ya?ml|csv|tsv|ts|mts|tsx|jsx|css|py|go|rs|java|c|h|cc|cpp|hpp|sh|zsh|sql|toml|ini|cfg|conf|vue)$/i;
const IMAGE_PREVIEW_EXT_RE = /^(png|jpe?g|gif|webp|avif|bmp|ico)$/i;

const TEXT_PLAIN = 'text/plain;charset=utf-8';

export type OpenFileAttachmentResult = 'previewed' | 'unsupported' | 'failed';

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

export async function openFileAttachment(
  api: Pick<KimiWebApi, 'getFileBlob'>,
  fileId: string,
  name?: string,
  mediaType?: string,
): Promise<OpenFileAttachmentResult> {
  const previewMime = safePreviewMime(name, mediaType);
  if (previewMime === null) return 'unsupported';
  const win = window.open('', '_blank');
  if (win !== null) win.opener = null;
  const blob = await api.getFileBlob(fileId).catch(() => null);
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

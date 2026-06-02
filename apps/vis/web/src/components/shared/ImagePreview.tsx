import { useState } from 'react';

import { CopyButton } from './CopyButton';

interface ImagePreviewProps {
  url: string;
  /** Optional label rendered as the header chip (e.g. `image_url`). */
  label?: string;
}

/** Inline preview for an image ContentPart URL.
 *  Renders the actual `<img>` for `data:image/*` and `http(s)://` URLs;
 *  falls back to the raw URL for any other scheme.
 *  Click "expand" to lift the height cap to 80vh; click "open in tab"
 *  to view the full asset in a new browser tab. */
export function ImagePreview({ url, label = 'image_url' }: ImagePreviewProps) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const supported =
    url.startsWith('data:image/') || /^https?:\/\//.test(url) || url.startsWith('/');
  const sizeLabel = url.startsWith('data:image/')
    ? `${url.length.toLocaleString()} chars`
    : new URL(url, window.location.href).hostname;

  if (!supported) {
    return (
      <div className="border border-border bg-surface-0 p-2">
        <div className="mb-1 font-mono text-[10px] text-fg-3">{label} (unsupported scheme)</div>
        <span className="break-all font-mono text-[12px] text-fg-1">{url}</span>
      </div>
    );
  }

  return (
    <div className="border border-border bg-surface-0 p-2">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] text-fg-3">
          {label}
          <span className="ml-2 text-fg-3">· {sizeLabel}</span>
        </span>
        <span className="flex items-center gap-2">
          <CopyButton value={url} label="copy url" />
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[10px] text-fg-3 hover:text-fg-1"
          >
            open in tab ↗
          </a>
          <button
            type="button"
            onClick={() => {
              setOpen((v) => !v);
            }}
            className="font-mono text-[10px] text-fg-3 hover:text-fg-1"
          >
            {open ? 'shrink' : 'expand'}
          </button>
        </span>
      </div>
      {failed ? (
        <div className="font-mono text-[11px] text-[var(--color-sev-error)]">
          failed to load image
        </div>
      ) : (
        <img
          src={url}
          alt="content image"
          loading="lazy"
          onError={() => {
            setFailed(true);
          }}
          className={
            'block max-w-full object-contain ' +
            (open ? 'max-h-[80vh]' : 'max-h-[220px]')
          }
        />
      )}
    </div>
  );
}

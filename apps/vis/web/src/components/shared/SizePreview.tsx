import { useState, type ReactNode } from 'react';

interface SizePreviewProps {
  label?: string;
  sizeBytes: number;
  preview?: string;
  children: ReactNode;
  defaultOpen?: boolean;
}

export function SizePreview({
  label = 'payload',
  sizeBytes,
  preview,
  children,
  defaultOpen = false,
}: SizePreviewProps) {
  const [open, setOpen] = useState(defaultOpen);
  const size = formatBytes(sizeBytes);
  return (
    <div className="my-1 border border-border bg-surface-0">
      <button
        onClick={() =>{  setOpen((v) => !v); }}
        className="flex w-full items-center justify-between gap-2 px-2 py-1 font-mono text-[11px] text-fg-2 hover:bg-surface-2 hover:text-fg-1"
      >
        <span className="flex items-center gap-2">
          <span className="text-fg-3">{open ? '▾' : '▸'}</span>
          <span className="uppercase tracking-[0.08em]">{label}</span>
          <span className="text-fg-3 tabular">{size}</span>
        </span>
        {!open && preview ? (
          <span className="truncate text-fg-3 font-mono text-[11px]">
            {preview.slice(0, 120)}
            {preview.length > 120 ? '…' : ''}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="border-t border-border px-2 py-1 font-mono text-[12px]">
          {children}
        </div>
      ) : null}
    </div>
  );
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}

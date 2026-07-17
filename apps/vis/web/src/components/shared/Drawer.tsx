import { useEffect, type ReactNode } from 'react';
import { t } from '../../i18n';

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  width?: number;
}

export function Drawer({ open, onClose, title, children, width = 560 }: DrawerProps) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () =>{  window.removeEventListener('keydown', handler); };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40">
      <div
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        className="absolute right-0 top-0 flex h-full flex-col border-l border-border bg-surface-1 shadow-2xl"
        style={{ width }}
      >
        <div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-4">
          <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-fg-1">
            {title}
          </span>
          <button
            onClick={onClose}
            className="font-mono text-[11px] text-fg-2 hover:text-fg-0"
            aria-label={t('drawer.close')}
          >
            esc ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
      </aside>
    </div>
  );
}

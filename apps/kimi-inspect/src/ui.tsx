/**
 * Small shared UI primitives for the inspector: JSON dump, badges, buttons,
 * relative time. Deliberately minimal — this is an internal devtool.
 */

import { useState } from 'react';

export function JsonView({ data, empty }: { data: unknown; empty?: string }) {
  const [open, setOpen] = useState(false);
  if (data === undefined || data === null) {
    return <div className="text-[11px] text-neutral-600 italic">{empty ?? 'no data'}</div>;
  }
  const text = JSON.stringify(data, null, 2);
  const long = text.length > 500;
  return (
    <pre
      className={`cursor-text overflow-auto rounded bg-neutral-950/70 p-2 font-mono text-[11px] leading-relaxed text-neutral-300 ${
        long && !open ? 'max-h-48' : 'max-h-[28rem]'
      }`}
      onClick={() => long && setOpen((v) => !v)}
      title={long ? 'click to expand / collapse' : undefined}
    >
      {long && !open ? `${text.slice(0, 500)}\n… (${text.length} chars, click to expand)` : text}
    </pre>
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'green' | 'amber' | 'red' | 'sky';
}) {
  const tones: Record<string, string> = {
    neutral: 'bg-neutral-800 text-neutral-300',
    green: 'bg-emerald-900/60 text-emerald-300',
    amber: 'bg-amber-900/60 text-amber-300',
    red: 'bg-red-900/60 text-red-300',
    sky: 'bg-sky-900/60 text-sky-300',
  };
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${tones[tone]}`}>{children}</span>
  );
}

export function ActionButton({
  children,
  onClick,
  danger,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void | Promise<void>;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      className={`rounded border px-2 py-1 text-[11px] transition-colors disabled:opacity-40 ${
        danger
          ? 'border-red-900/70 text-red-400 hover:bg-red-950/60'
          : 'border-neutral-700 text-neutral-300 hover:bg-neutral-800'
      }`}
      disabled={disabled}
      onClick={() => {
        void onClick();
      }}
    >
      {children}
    </button>
  );
}

export function relTime(epochMs: number | undefined): string {
  if (epochMs === undefined) return '';
  const diff = Date.now() - epochMs;
  if (diff < 60_000) return `${Math.max(0, Math.round(diff / 1000))}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return new Date(epochMs).toLocaleDateString();
}

/** Render an unknown thrown value as display text (never "[object Object]"). */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error === null || typeof error !== 'object') return String(error);
  return JSON.stringify(error) ?? 'unknown error';
}

export function ErrorLine({ error }: { error: unknown }) {
  if (error === null || error === undefined) return null;
  const msg = errorMessage(error);
  return <div className="rounded bg-red-950/50 px-2 py-1 text-[11px] text-red-400">{msg}</div>;
}

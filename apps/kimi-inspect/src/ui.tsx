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
  tone?: 'neutral' | 'green' | 'amber' | 'red' | 'sky' | 'violet';
}) {
  const tones: Record<string, string> = {
    neutral: 'bg-neutral-800 text-neutral-300',
    green: 'bg-emerald-900/60 text-emerald-300',
    amber: 'bg-amber-900/60 text-amber-300',
    red: 'bg-red-900/60 text-red-300',
    sky: 'bg-sky-900/60 text-sky-300',
    violet: 'bg-violet-900/60 text-violet-300',
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

// ---------------------------------------------------------------------------
// JSON tree (selectable) — the left column of the model inspect panel.
// ---------------------------------------------------------------------------

export function JsonTree({
  data,
  selectedPath,
  onSelect,
  defaultDepth = 2,
  rowClassName,
}: {
  readonly data: unknown;
  readonly selectedPath?: string;
  readonly onSelect: (path: string) => void;
  readonly defaultDepth?: number;
  /** Per-row styling hook (e.g. provenance colors); receives the node's dot path. */
  readonly rowClassName?: (path: string) => string | undefined;
}) {
  return (
    <div className="py-1 font-mono text-[11px] leading-[1.7]">
      <TreeNode
        name={undefined}
        value={data}
        path=""
        depth={0}
        defaultDepth={defaultDepth}
        selectedPath={selectedPath}
        onSelect={onSelect}
        rowClassName={rowClassName}
      />
    </div>
  );
}

function TreeNode({
  name,
  value,
  path,
  depth,
  defaultDepth,
  selectedPath,
  onSelect,
  rowClassName,
}: {
  readonly name?: string;
  readonly value: unknown;
  readonly path: string;
  readonly depth: number;
  readonly defaultDepth: number;
  readonly selectedPath?: string;
  readonly onSelect: (path: string) => void;
  readonly rowClassName?: (path: string) => string | undefined;
}) {
  const [open, setOpen] = useState(depth < defaultDepth);
  const expandable = value !== null && typeof value === 'object';
  const pathClass = rowClassName?.(path);

  // The root renders its entries directly (no row of its own).
  if (path === '' && name === undefined && expandable) {
    const entries = Array.isArray(value)
      ? value.map((item, index) => [String(index), item] as const)
      : Object.entries(value);
    return (
      <>
        {entries.map(([key, item]) => (
          <TreeNode
            key={key}
            name={key}
            value={item}
            path={key}
            depth={depth}
            defaultDepth={defaultDepth}
            selectedPath={selectedPath}
            onSelect={onSelect}
            rowClassName={rowClassName}
          />
        ))}
      </>
    );
  }

  if (!expandable) {
    return (
      <TreeRow
        path={path}
        depth={depth}
        selectedPath={selectedPath}
        onSelect={onSelect}
        rowClass={pathClass}
      >
        {name !== undefined ? (
          <span className={pathClass ?? 'text-neutral-400'}>{name}: </span>
        ) : null}
        <LeafValue value={value} className={pathClass} />
      </TreeRow>
    );
  }

  const isArray = Array.isArray(value);
  // Undefined is not JSON: records carry optional keys explicitly set to
  // undefined — skip them entirely instead of rendering source-less noise.
  const entries = isArray
    ? value.map((item, index) => [String(index), item] as const)
    : Object.entries(value as Record<string, unknown>).filter(
        ([, item]) => item !== undefined,
      );
  const [openBrace, closeBrace] = isArray ? ['[', ']'] : ['{', '}'];
  return (
    <div>
      <TreeRow
        path={path}
        depth={depth}
        selectedPath={selectedPath}
        onSelect={onSelect}
        rowClass={pathClass}
      >
        <span
          className="cursor-pointer select-none text-neutral-600 hover:text-neutral-300"
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
        >
          {open ? '▾ ' : '▸ '}
        </span>
        {name !== undefined ? (
          <span className={pathClass ?? 'text-neutral-400'}>{name}: </span>
        ) : null}
        <span
          className="cursor-pointer select-none text-neutral-600"
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
        >
          {open ? openBrace : `${openBrace} …${entries.length} ${closeBrace}`}
        </span>
      </TreeRow>
      {open
        ? entries.map(([key, item]) => (
            <TreeNode
              key={key}
              name={key}
              value={item}
              path={path === '' ? key : `${path}.${key}`}
              depth={depth + 1}
              defaultDepth={defaultDepth}
              selectedPath={selectedPath}
              onSelect={onSelect}
              rowClassName={rowClassName}
            />
          ))
        : null}
    </div>
  );
}

function TreeRow({
  path,
  depth,
  selectedPath,
  onSelect,
  rowClass,
  children,
}: {
  readonly path: string;
  readonly depth: number;
  readonly selectedPath?: string;
  readonly onSelect: (path: string) => void;
  readonly rowClass?: string;
  readonly children: React.ReactNode;
}) {
  const selected = path !== '' && path === selectedPath;
  return (
    <div
      className={`cursor-pointer truncate border-l-2 px-1 hover:bg-neutral-800/70 ${
        rowClass ?? 'border-transparent'
      } ${selected ? 'bg-sky-950/70 text-neutral-100' : ''}`}
      style={{ paddingLeft: `${depth * 14 + 4}px` }}
      onClick={() => {
        onSelect(path);
      }}
      title={path}
    >
      {children}
    </div>
  );
}

function LeafValue({ value, className }: { readonly value: unknown; readonly className?: string }) {
  if (value === null) return <span className={className ?? 'text-neutral-600'}>null</span>;
  if (value === undefined) {
    return <span className={className ?? 'text-neutral-600'}>undefined</span>;
  }
  if (typeof value === 'string') {
    const shown = value.length > 80 ? `${value.slice(0, 80)}…` : value;
    return <span className={className ?? 'text-emerald-300/80'}>"{shown}"</span>;
  }
  if (typeof value === 'number') {
    return <span className={className ?? 'text-amber-300/80'}>{String(value)}</span>;
  }
  if (typeof value === 'boolean') {
    return <span className={className ?? 'text-violet-300/80'}>{String(value)}</span>;
  }
  return <span className={className ?? 'text-neutral-500'}>{JSON.stringify(value) ?? 'unknown'}</span>;
}

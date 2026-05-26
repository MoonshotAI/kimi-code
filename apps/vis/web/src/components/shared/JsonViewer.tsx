import { useState, memo } from 'react';

import { CopyButton } from './CopyButton';

interface JsonViewerProps {
  value: unknown;
  /** Default-open nesting depth */
  defaultOpenDepth?: number;
}

/** Strings longer than this get an inline expand affordance instead of a
 *  truncated preview-only display. */
const LONG_STRING_THRESHOLD = 200;

export function JsonViewer({ value, defaultOpenDepth = 2 }: JsonViewerProps) {
  return (
    <div className="font-mono text-[12px] leading-[1.5]">
      <Node value={value} depth={0} defaultOpenDepth={defaultOpenDepth} keyPath="" />
    </div>
  );
}

interface NodeProps {
  value: unknown;
  depth: number;
  defaultOpenDepth: number;
  keyPath: string;
  keyLabel?: string | number;
  isLast?: boolean;
}

const Node = memo(function Node({
  value,
  depth,
  defaultOpenDepth,
  keyPath,
  keyLabel,
  isLast,
}: NodeProps) {
  const [open, setOpen] = useState(depth < defaultOpenDepth);

  if (value === null)
    return <Leaf keyLabel={keyLabel} repr="null" color="text-fg-3" isLast={isLast} />;
  if (value === undefined)
    return <Leaf keyLabel={keyLabel} repr="undefined" color="text-fg-3" isLast={isLast} />;
  if (typeof value === 'boolean')
    return <Leaf keyLabel={keyLabel} repr={String(value)} color="text-[var(--color-cat-config)]" isLast={isLast} />;
  if (typeof value === 'number')
    return <Leaf keyLabel={keyLabel} repr={String(value)} color="text-[var(--color-sev-info)]" isLast={isLast} />;
  if (typeof value === 'string') {
    if (value.length <= LONG_STRING_THRESHOLD) {
      return (
        <Leaf
          keyLabel={keyLabel}
          repr={JSON.stringify(value)}
          color="text-[var(--color-cat-ephemeral)]"
          isLast={isLast}
        />
      );
    }
    return (
      <div>
        <button
          onClick={() => {
            setOpen((v) => !v);
          }}
          className="flex items-baseline gap-1 text-left hover:text-fg-0"
        >
          <span className="text-fg-3 w-3 shrink-0 inline-block">{open ? '▾' : '▸'}</span>
          {keyLabel !== undefined ? (
            <>
              <span className="text-fg-1">{keyLabel}</span>
              <span className="text-fg-3">:</span>
            </>
          ) : null}
          <span className="truncate text-[var(--color-cat-ephemeral)]">
            {`"${value.slice(0, LONG_STRING_THRESHOLD)}…"`}
          </span>
          <span className="text-fg-3 shrink-0">({value.length.toLocaleString()} chars)</span>
        </button>
        {open ? (
          <div className="ml-[5px] my-1 border-l border-border pl-3">
            <div className="relative border border-border bg-surface-0">
              <div className="absolute top-1 right-1 z-10">
                <CopyButton value={value} className="border border-border bg-surface-1 px-1.5 py-0.5" />
              </div>
              <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words p-2 pr-16 font-mono text-[12px] leading-[1.55] text-fg-0">
                {value}
              </pre>
            </div>
          </div>
        ) : null}
      </div>
    );
  }
  if (Array.isArray(value)) {
    if (value.length === 0)
      return <Leaf keyLabel={keyLabel} repr="[]" color="text-fg-3" isLast={isLast} />;
    return (
      <div>
        <button
          onClick={() =>{  setOpen((v) => !v); }}
          className="flex items-baseline gap-1 text-left hover:text-fg-0"
        >
          <span className="text-fg-3 w-3 shrink-0 inline-block">{open ? '▾' : '▸'}</span>
          {keyLabel !== undefined ? (
            <span className="text-fg-1">{keyLabel}</span>
          ) : null}
          {keyLabel !== undefined ? <span className="text-fg-3">:</span> : null}
          <span className="text-fg-3">
            [{value.length}]
          </span>
        </button>
        {open ? (
          <div className="border-l border-border ml-[5px] pl-3">
            {value.map((v, i) => (
              <Node
                key={i}
                value={v}
                depth={depth + 1}
                defaultOpenDepth={defaultOpenDepth}
                keyPath={`${keyPath}[${i}]`}
                keyLabel={i}
                isLast={i === value.length - 1}
              />
            ))}
          </div>
        ) : null}
      </div>
    );
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0)
      return <Leaf keyLabel={keyLabel} repr="{}" color="text-fg-3" isLast={isLast} />;
    return (
      <div>
        <button
          onClick={() =>{  setOpen((v) => !v); }}
          className="flex items-baseline gap-1 text-left hover:text-fg-0"
        >
          <span className="text-fg-3 w-3 shrink-0 inline-block">{open ? '▾' : '▸'}</span>
          {keyLabel !== undefined ? (
            <span className="text-fg-1">{keyLabel}</span>
          ) : null}
          {keyLabel !== undefined ? <span className="text-fg-3">:</span> : null}
          <span className="text-fg-3">
            {'{'}
            {entries.length}
            {'}'}
          </span>
        </button>
        {open ? (
          <div className="border-l border-border ml-[5px] pl-3">
            {entries.map(([k, v], i) => (
              <Node
                key={k}
                value={v}
                depth={depth + 1}
                defaultOpenDepth={defaultOpenDepth}
                keyPath={`${keyPath}.${k}`}
                keyLabel={k}
                isLast={i === entries.length - 1}
              />
            ))}
          </div>
        ) : null}
      </div>
    );
  }
  return <Leaf keyLabel={keyLabel} repr={typeof value} color="text-fg-3" isLast={isLast} />;
});

function Leaf({
  keyLabel,
  repr,
  color,
}: {
  keyLabel?: string | number;
  repr: string;
  color: string;
  isLast?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-1">
      <span className="w-3 shrink-0" />
      {keyLabel !== undefined ? (
        <>
          <span className="text-fg-1">{keyLabel}</span>
          <span className="text-fg-3">:</span>
        </>
      ) : null}
      <span className={color}>{repr}</span>
    </div>
  );
}

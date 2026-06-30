import { useRef } from 'react';

import type { SessionSortKey, HealthFilter, SourceFilter } from './SessionRail';

interface SessionFilterProps {
  search: string;
  onSearchChange: (v: string) => void;
  sortKey: SessionSortKey;
  onSortChange: (v: SessionSortKey) => void;
  healthFilter: HealthFilter;
  onHealthChange: (v: HealthFilter) => void;
  sourceFilter: SourceFilter;
  onSourceChange: (v: SourceFilter) => void;
  totalCount: number;
  filteredCount: number;
  importedCount: number;
  onImport: (file: File) => void;
  importing: boolean;
}

const SORT_OPTIONS: { value: SessionSortKey; label: string }[] = [
  { value: 'recent', label: 'recent' },
  { value: 'oldest', label: 'oldest' },
  { value: 'most_records', label: 'most records' },
  { value: 'most_subagents', label: 'most subagents' },
];

const HEALTH_OPTIONS: { value: HealthFilter; label: string }[] = [
  { value: 'all', label: 'any' },
  { value: 'ok', label: 'ok' },
  { value: 'broken_state', label: 'broken state' },
  { value: 'broken_main_wire', label: 'broken wire' },
  { value: 'missing_main_wire', label: 'no wire' },
];

const SOURCE_OPTIONS: { value: SourceFilter; label: string }[] = [
  { value: 'all', label: 'all' },
  { value: 'local', label: 'local' },
  { value: 'imported', label: 'imported' },
];

export function SessionFilter({
  search,
  onSearchChange,
  sortKey,
  onSortChange,
  healthFilter,
  onHealthChange,
  sourceFilter,
  onSourceChange,
  totalCount,
  filteredCount,
  importedCount,
  onImport,
  importing,
}: SessionFilterProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  return (
    <div className="border-b border-border bg-surface-1 px-3 py-2">
      <div className="mb-2 flex items-center gap-2">
        <input
          ref={fileInput}
          type="file"
          accept=".zip,application/zip"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onImport(file);
            e.target.value = '';
          }}
        />
        <button
          type="button"
          disabled={importing}
          onClick={() => fileInput.current?.click()}
          className="flex items-center gap-1.5 border border-border bg-surface-0 px-2 py-1 font-mono text-[11px] text-fg-1 hover:border-border-strong hover:text-fg-0 disabled:opacity-50"
          title="Import a /export-debug-zip bundle a user sent you"
        >
          {importing ? 'importing…' : '⬆ import debug zip'}
        </button>
        {importedCount > 0 ? (
          <span className="font-mono text-[10px] text-fg-3 tabular">{importedCount} imported</span>
        ) : null}
      </div>
      <div className="relative">
        <input
          type="text"
          value={search}
          onChange={(e) => { onSearchChange(e.target.value); }}
          placeholder="search id / title / workspace"
          className="w-full border border-border bg-surface-0 px-2 py-1 font-mono text-[12px] text-fg-0 placeholder:text-fg-3 focus:border-border-strong focus:outline-none"
        />
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <label className="flex items-center gap-1.5 font-mono text-[10.5px] text-fg-2">
          <span className="text-fg-3">sort</span>
          <select
            value={sortKey}
            onChange={(e) => { onSortChange(e.target.value as SessionSortKey); }}
            className="flex-1 border border-border bg-surface-0 px-1 py-0.5 text-fg-1 focus:border-border-strong focus:outline-none"
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 font-mono text-[10.5px] text-fg-2">
          <span className="text-fg-3">source</span>
          <select
            value={sourceFilter}
            onChange={(e) => { onSourceChange(e.target.value as SourceFilter); }}
            className="flex-1 border border-border bg-surface-0 px-1 py-0.5 text-fg-1 focus:border-border-strong focus:outline-none"
          >
            {SOURCE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 font-mono text-[10.5px] text-fg-2">
          <span className="text-fg-3">health</span>
          <select
            value={healthFilter}
            onChange={(e) => { onHealthChange(e.target.value as HealthFilter); }}
            className="flex-1 border border-border bg-surface-0 px-1 py-0.5 text-fg-1 focus:border-border-strong focus:outline-none"
          >
            {HEALTH_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center justify-end">
          <span className="font-mono text-[10px] text-fg-3 tabular">
            {filteredCount} / {totalCount}
          </span>
        </div>
      </div>
    </div>
  );
}

import type { SessionSortKey, HealthFilter } from './SessionRail';

interface SessionFilterProps {
  search: string;
  onSearchChange: (v: string) => void;
  sortKey: SessionSortKey;
  onSortChange: (v: SessionSortKey) => void;
  healthFilter: HealthFilter;
  onHealthChange: (v: HealthFilter) => void;
  totalCount: number;
  filteredCount: number;
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
  { value: 'unsupported_protocol', label: 'old proto' },
];

export function SessionFilter({
  search,
  onSearchChange,
  sortKey,
  onSortChange,
  healthFilter,
  onHealthChange,
  totalCount,
  filteredCount,
}: SessionFilterProps) {
  return (
    <div className="border-b border-border bg-surface-1 px-3 py-2">
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
      </div>
      <div className="mt-2 flex items-center justify-end">
        <span className="font-mono text-[10px] text-fg-3 tabular">
          {filteredCount} / {totalCount}
        </span>
      </div>
    </div>
  );
}

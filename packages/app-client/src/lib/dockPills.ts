export type DockPillKey = 'goal' | 'plan' | 'bash' | 'subagent' | 'todos';

export interface DockPillMeasure {
  key: DockPillKey;
  priority: number;
  expandedWidth: number;
  collapsedWidth: number;
}

export interface DockPillCollapsePlan {
  collapsed: DockPillKey[];
  collapsedAt: Partial<Record<DockPillKey, number>>;
}

export const DOCK_PILL_EXPAND_MARGIN_PX = 48;

export const LIVE_PILL_PRIORITY = Number.MAX_SAFE_INTEGER;

export function dockTasksPillPriority(
  tasks: readonly { state: string; completedAt?: string; createdAt?: string }[],
): number {
  if (tasks.some((t) => t.state === 'run')) return LIVE_PILL_PRIORITY;
  let best = 0;
  for (const t of tasks) {
    const ts = Date.parse(t.completedAt ?? t.createdAt ?? '');
    if (Number.isFinite(ts) && ts > best) best = ts;
  }
  return best;
}

export function planDockPillCollapse(input: {
  pills: readonly DockPillMeasure[];
  availableWidth: number;
  gap: number;
  collapsed: readonly DockPillKey[];
  collapsedAt: Readonly<Partial<Record<DockPillKey, number>>>;
  dockWidth: number;
  expandMargin?: number;
}): DockPillCollapsePlan {
  const margin = input.expandMargin ?? DOCK_PILL_EXPAND_MARGIN_PX;
  const hold = new Set(
    input.collapsed.filter((key) => input.dockWidth <= (input.collapsedAt[key] ?? 0) + margin),
  );
  const collapsed = new Set(input.collapsed.filter((key) => hold.has(key)));
  const collapsedAt: Partial<Record<DockPillKey, number>> = { ...input.collapsedAt };

  const fits = (): boolean => {
    if (input.pills.length === 0) return true;
    let used = (input.pills.length - 1) * input.gap;
    for (const p of input.pills) used += collapsed.has(p.key) ? p.collapsedWidth : p.expandedWidth;
    return used <= input.availableWidth;
  };

  if (!fits()) {
    const byImportance = input.pills
      .map((p, i) => ({ p, i }))
      .sort((a, b) => a.p.priority - b.p.priority || b.i - a.i);
    for (const { p } of byImportance) {
      if (collapsed.has(p.key)) continue;
      collapsed.add(p.key);
      collapsedAt[p.key] = input.dockWidth;
      break;
    }
  }
  return {
    collapsed: input.pills.filter((p) => collapsed.has(p.key)).map((p) => p.key),
    collapsedAt,
  };
}

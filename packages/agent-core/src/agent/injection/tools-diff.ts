/**
 * ToolsDiffInjector — maintains the loadable-tools manifest in context via
 * turn-boundary diffs (`<tools_added>/<tools_removed>` announcements).
 *
 * Three deliberate departures from the DynamicInjector defaults:
 *   - Boundary cadence, not per-step: invoked next to injectGoal at turn start
 *     and after full compaction, never from the per-step inject() loop. Server
 *     connects/disconnects mid-turn are simply observed at the next boundary
 *     (a same-turn drop+reconnect nets out — natural debouncing).
 *   - Not main-only: subagents run their own disclosure and need the manifest.
 *   - `system_trigger` origin, not `injection`: undo must REMOVE announcements
 *     (the folded state rolls back with the conversation) and the next
 *     boundary diff self-heals; `injection` origin would survive undo.
 *
 * There is no in-memory "announced" ledger: the announcements in history ARE
 * the ledger, re-folded on every boundary. Undo, compaction, and resume all
 * self-heal for free, at the cost of one cheap origin-anchored scan per turn.
 */

import type { Agent } from '..';
import {
  foldAnnouncedToolNames,
  LOADABLE_TOOLS_TRIGGER,
  renderLoadableToolsAnnouncement,
} from '../context/dynamic-tools';

export class ToolsDiffInjector {
  constructor(protected readonly agent: Agent) {}

  /**
   * Recompute the loadable set, fold the announced set from history, and
   * append one diff announcement iff they differ. Most turns append nothing,
   * keeping the prompt cache warm; the first announcement after session start
   * (or after compaction folded the history) is naturally the full list.
   */
  inject(): void {
    if (!this.agent.toolSelectEnabled) return;
    const loadable = this.agent.tools.loadableDynamicToolNames();
    const loadableSet = new Set(loadable);
    const announced = foldAnnouncedToolNames(this.agent.context.history);
    const added = loadable.filter((name) => !announced.has(name));
    const removed = [...announced]
      .filter((name) => !loadableSet.has(name))
      .toSorted((a, b) => a.localeCompare(b));
    if (added.length === 0 && removed.length === 0) return;
    this.agent.context.appendSystemReminder(
      renderLoadableToolsAnnouncement(added, removed),
      { kind: 'system_trigger', name: LOADABLE_TOOLS_TRIGGER },
    );
  }
}

/**
 * WorkflowPanelComponent — live status panel for running workflow runs.
 *
 * Mounted as a dedicated `Container` slot between the todo panel and the
 * queue editor. The host calls {@link setRuns} whenever a Workflow tool
 * event arrives; state survives across turns so the panel stays visible
 * until the workflow finishes.
 *
 * Each run is rendered as a compact row with:
 *   ⚡ deep-research (wf_3)  ●  Plan  ✓  2agents
 *
 * The status icon tracks the run's lifecycle:
 *   ● (amber)  →  running
 *   ✓ (green)  →  completed
 *   ✗ (red)    →  failed
 *   ⊘ (dim)    →  cancelled
 */

import type { Component } from '@moonshot-ai/pi-tui';
import { truncateToWidth } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';

import { t } from '#/i18n';

import { currentTheme } from '#/tui/theme';
import type { ColorPalette } from '#/tui/theme/colors';

export type WorkflowStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface WorkflowRunData {
  readonly runId: string;
  readonly name: string;
  readonly status: WorkflowStatus;
  readonly currentPhase?: string;
  readonly agentCount: number;
  readonly startedAt: number;
  readonly finishedAt?: number;
}

export const MAX_VISIBLE_RUNS = 5;

export class WorkflowPanelComponent implements Component {
  private runs: readonly WorkflowRunData[] = [];
  private expanded = false;

  setRuns(runs: readonly WorkflowRunData[]): void {
    this.runs = runs.map((r) => ({ ...r }));
  }

  clear(): void {
    this.runs = [];
    this.expanded = false;
  }

  isEmpty(): boolean {
    return this.runs.length === 0;
  }

  hasOverflow(): boolean {
    return this.runs.length > MAX_VISIBLE_RUNS;
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
  }

  toggleExpanded(): void {
    this.expanded = !this.expanded;
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (this.runs.length === 0) return [];
    const c = currentTheme.palette;
    const lines: string[] = [
      chalk.hex(c.border)('\u2500'.repeat(width)),
      chalk.hex(c.primary).bold(`  \u26a1 ${t('tui.chrome.workflowPanel.header')}`),
    ];

    const visible = this.expanded ? this.runs : this.runs.slice(0, MAX_VISIBLE_RUNS);

    for (const run of visible) {
      lines.push(renderRunRow(run, c, width));
    }

    if (!this.expanded && this.runs.length > MAX_VISIBLE_RUNS) {
      const hidden = this.runs.length - MAX_VISIBLE_RUNS;
      const running = this.runs.filter((r) => r.status === 'running').length;
      const parts: string[] = [];
      if (running > 0) parts.push(`${running} ${t('tui.chrome.workflowPanel.running')}`);
      const suffix = parts.length > 0 ? ` (${parts.join(', ')})` : '';
      lines.push(
        chalk.hex(c.textDim)(
          `  \u2026 +${hidden} more${suffix}`,
        ),
      );
    }

    return lines.map((line) => truncateToWidth(line, width));
  }
}

function renderRunRow(run: WorkflowRunData, c: ColorPalette, _width: number): string {
  const badge = statusBadge(run.status, c);
  const elapsed = formatElapsed(run.startedAt, run.finishedAt);
  const phase = run.currentPhase
    ? chalk.hex(c.textDim)(` \u00b7 ${chalk.hex(c.text)(run.currentPhase)}`)
    : '';
  const agents =
    run.agentCount > 0
      ? chalk.hex(c.textDim)(` \u00b7 ${run.agentCount} agent${run.agentCount > 1 ? 's' : ''}`)
      : '';
  const timeStr = chalk.hex(c.textDim)(` \u00b7 ${elapsed}`);

  return `  ${badge} ${chalk.hex(c.text)(run.name)}${timeStr}${phase}${agents}`;
}

function statusBadge(status: WorkflowStatus, c: ColorPalette): string {
  switch (status) {
    case 'running':
      return chalk.hex(c.warning).bold('\u25cf');
    case 'completed':
      return chalk.hex(c.success)('\u2713');
    case 'failed':
      return chalk.hex(c.error)('\u2717');
    case 'cancelled':
      return chalk.hex(c.textDim)('\u2298');
  }
}

function formatElapsed(startedAt: number, finishedAt?: number): string {
  const ms = (finishedAt ?? Date.now()) - startedAt;
  if (ms < 1000) return '<1s';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m${sec % 60}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h${min % 60}m`;
}
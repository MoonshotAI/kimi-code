/**
 * WorkflowsBrowserApp — full-screen browser for dynamic workflow runs.
 * Left: the run list (status, phase progress, agent calls). Right: the
 * selected run's detail (phases with the current one marked, error/result,
 * log tail). Keys: ↑↓ select · c cancel run · s save to project · S save to
 * user · v view script · r refresh · Esc close.
 */

import {
  Container,
  Key,
  matchesKey,
  type Terminal,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@moonshot-ai/pi-tui';
import type { WorkflowRunDetail, WorkflowRunSnapshot } from '@moonshot-ai/kimi-code-sdk';

import { SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { printableChar } from '@/tui/utils/printable-key';

export interface WorkflowsBrowserProps {
  readonly runs: readonly WorkflowRunSnapshot[];
  readonly selectedRunId: string | undefined;
  readonly detail: WorkflowRunDetail | undefined;
  readonly detailLoading: boolean;
  readonly flashMessage: string | undefined;
  readonly onSelect: (runId: string) => void;
  readonly onCancel: () => void;
  readonly onCancelRun: (runId: string) => void;
  readonly onSaveRun: (runId: string, scope: 'project' | 'user') => void;
  readonly onViewScript: (runId: string) => void;
  readonly onRefresh: () => void;
}

const STATUS_COLOR: Record<WorkflowRunSnapshot['status'], 'success' | 'textMuted' | 'error' | 'warning'> = {
  running: 'success',
  completed: 'textMuted',
  failed: 'error',
  cancelled: 'warning',
};

function phaseProgress(run: WorkflowRunSnapshot): string {
  if (run.phases.length === 0) return '';
  const current = run.phaseIndex !== undefined ? run.phaseIndex + 1 : run.phases.length;
  return `${String(Math.min(current, run.phases.length))}/${String(run.phases.length)}`;
}

function fit(line: string, width: number): string {
  return truncateToWidth(line, Math.max(1, width), '…');
}

export class WorkflowsBrowserApp extends Container implements Focusable {
  focused = false;

  private props: WorkflowsBrowserProps;

  constructor(
    props: WorkflowsBrowserProps,
    private readonly terminal: Terminal,
  ) {
    super();
    this.props = props;
  }

  setProps(next: WorkflowsBrowserProps): void {
    this.props = next;
    this.invalidate();
  }

  handleInput(data: string): void {
    const k = printableChar(data);
    if (matchesKey(data, Key.escape) || k === 'q' || k === 'Q') {
      this.props.onCancel();
      return;
    }
    const runs = this.props.runs;
    const index = runs.findIndex((run) => run.runId === this.props.selectedRunId);
    if (matchesKey(data, Key.up)) {
      const next = runs[Math.max(0, index - 1)];
      if (next !== undefined && next.runId !== this.props.selectedRunId) {
        this.props.onSelect(next.runId);
      }
      return;
    }
    if (matchesKey(data, Key.down)) {
      const next = runs[Math.min(runs.length - 1, index + 1)];
      if (next !== undefined && next.runId !== this.props.selectedRunId) {
        this.props.onSelect(next.runId);
      }
      return;
    }
    const selected = this.props.selectedRunId;
    if (k === 'r' || k === 'R') {
      this.props.onRefresh();
      return;
    }
    if (selected === undefined) return;
    if (k === 'c' || k === 'C') {
      this.props.onCancelRun(selected);
      return;
    }
    if (k === 's') {
      this.props.onSaveRun(selected, 'project');
      return;
    }
    if (k === 'S') {
      this.props.onSaveRun(selected, 'user');
      return;
    }
    if (k === 'v' || k === 'V') {
      this.props.onViewScript(selected);
    }
  }

  override render(width: number): string[] {
    const rows = Math.max(6, this.terminal.rows);
    const out: string[] = [];
    out.push(fit(currentTheme.boldFg('primary', ' Workflow runs ') + currentTheme.fg('textMuted', `(${String(this.props.runs.length)})`), width));
    out.push(currentTheme.fg('primary', '─'.repeat(width)));

    const bodyRows = rows - 4;
    const listWidth = Math.min(44, Math.max(24, Math.floor(width / 2)));
    for (let i = 0; i < bodyRows; i++) {
      const left = this.renderListLine(i, listWidth);
      const right = this.renderDetailLine(i, width - listWidth - 1);
      out.push(left + currentTheme.fg('primary', '│') + right);
    }

    out.push(currentTheme.fg('primary', '─'.repeat(width)));
    out.push(fit(this.renderFooter(width), width));
    return out;
  }

  private renderListLine(index: number, width: number): string {
    const run = this.props.runs[index];
    if (run === undefined) {
      if (index === 0 && this.props.runs.length === 0) {
        return pad(currentTheme.fg('textMuted', ' No workflow runs yet.'), width);
      }
      return pad('', width);
    }
    const selected = run.runId === this.props.selectedRunId;
    const pointer = selected ? SELECT_POINTER : ' ';
    const status = currentTheme.fg(STATUS_COLOR[run.status], run.status.padEnd(9));
    const name = currentTheme.fg(selected ? 'textStrong' : 'text', run.workflowName);
    const progress = currentTheme.fg('textMuted', `${phaseProgress(run)} · ${String(run.agentCalls)} calls`);
    return pad(` ${currentTheme.fg('primary', pointer)} ${status} ${name} ${progress}`, width);
  }

  private renderDetailLine(index: number, width: number): string {
    const lines = this.detailLines();
    return pad(lines[index] ?? '', width);
  }

  private detailLines(): string[] {
    if (this.props.flashMessage !== undefined) {
      return [currentTheme.fg('warning', ` ${this.props.flashMessage}`)];
    }
    if (this.props.selectedRunId === undefined) return [currentTheme.fg('textMuted', ' Select a run.')];
    if (this.props.detailLoading) return [currentTheme.fg('textMuted', ' Loading…')];
    const detail = this.props.detail;
    if (detail === undefined) return [currentTheme.fg('textMuted', ' Run not found.')];

    const lines: string[] = [];
    lines.push(currentTheme.boldFg('text', ` ${detail.workflowName}`) + currentTheme.fg('textMuted', ` (${detail.runId})`));
    lines.push(currentTheme.fg(STATUS_COLOR[detail.status], ` ${detail.status}`) + currentTheme.fg('textMuted', ` · ${String(detail.agentCalls)} agent calls · source ${detail.source}`));
    if (detail.args.length > 0) lines.push(currentTheme.fg('textMuted', ` args: ${detail.args}`));
    lines.push('');
    detail.phases.forEach((phase, i) => {
      const current = i === detail.phaseIndex && detail.status === 'running';
      const done = detail.phaseIndex !== undefined && i < detail.phaseIndex;
      const marker = current ? '▶' : done ? '✓' : '·';
      lines.push(
        ` ${currentTheme.fg(current ? 'success' : 'textMuted', marker)} ${currentTheme.fg(current ? 'textStrong' : 'textMuted', phase.title)}${phase.detail !== undefined ? currentTheme.fg('textMuted', ` — ${phase.detail}`) : ''}`,
      );
    });
    lines.push('');
    if (detail.error !== undefined) {
      lines.push(currentTheme.fg('error', ` error: ${detail.error}`));
    }
    if (detail.resultJson !== undefined) {
      const result = detail.resultJson.length > 300 ? detail.resultJson.slice(0, 300) + '…' : detail.resultJson;
      lines.push(currentTheme.fg('textMuted', ' result: ' + result));
    }
    if (detail.logs.length > 0) {
      lines.push(currentTheme.fg('textMuted', ' logs:'));
      for (const log of detail.logs.slice(-8)) {
        lines.push(currentTheme.fg('textMuted', `  ${log}`));
      }
    }
    return lines;
  }

  private renderFooter(width: number): string {
    const key = (text: string): string => currentTheme.boldFg('primary', text);
    const dim = (text: string): string => currentTheme.fg('textMuted', text);
    const footer =
      ` ${key('↑↓')} ${dim('select')}  ${key('c')} ${dim('cancel run')}  ${key('s/S')} ${dim('save project/user')}  ${key('v')} ${dim('view script')}  ${key('r')} ${dim('refresh')}  ${key('Esc')} ${dim('close')}`;
    return visibleWidth(footer) <= width ? footer : ` ${key('↑↓')} ${dim('select')}  ${key('c')} ${dim('cancel')}  ${key('s/S')} ${dim('save')}  ${key('v')} ${dim('script')}  ${key('Esc')} ${dim('close')}`;
  }
}

function pad(line: string, width: number): string {
  const w = visibleWidth(line);
  if (w >= width) return truncateToWidth(line, Math.max(1, width), '…');
  return line + ' '.repeat(width - w);
}

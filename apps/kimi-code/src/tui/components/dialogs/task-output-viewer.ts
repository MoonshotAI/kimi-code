import type { Terminal } from '@moonshot-ai/pi-tui';
import type { BackgroundTaskInfo, BackgroundTaskStatus } from '@moonshot-ai/kimi-code-sdk';

import { currentTheme } from '#/tui/theme';
import { sanitizeShellOutput } from '#/tui/utils/shell-output';

import {
  fitViewerLine,
  FramedScrollViewer,
  type ViewerFooterItem,
} from './framed-scroll-viewer';

export interface TaskOutputViewerProps {
  readonly taskId: string;
  readonly info: BackgroundTaskInfo | undefined;
  readonly output: string;
  readonly onClose: () => void;
  readonly requestRender?: () => void;
}

export const STATUS_LABEL: Record<BackgroundTaskStatus, string> = {
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  timed_out: 'timed out',
  killed: 'killed',
  lost: 'lost',
};

export function statusColor(status: BackgroundTaskStatus): 'success' | 'textMuted' | 'error' {
  switch (status) {
    case 'running':
      return 'success';
    case 'completed':
      return 'textMuted';
    case 'failed':
    case 'timed_out':
    case 'killed':
    case 'lost':
      return 'error';
  }
}

export class TaskOutputViewer extends FramedScrollViewer {
  private props: TaskOutputViewerProps;
  private rawLines: string[];
  private styledLines: readonly string[] | undefined;
  private styledPalette: unknown;

  constructor(props: TaskOutputViewerProps, terminal: Terminal) {
    super({
      terminal,
      enableHalfPageCtrlKeys: true,
      requestRender: props.requestRender,
    });
    this.props = props;
    this.rawLines = this.splitOutput(props.output);
  }

  setProps(next: TaskOutputViewerProps): void {
    const previousOutput = this.props.output;
    const wasAtBottom = this.isAtBottom();
    this.props = next;
    this.setRequestRender(next.requestRender);
    if (next.output !== previousOutput) {
      this.rawLines = this.splitOutput(next.output);
      this.styledLines = undefined;
      this.syncAfterContentUpdate(wasAtBottom, this.rawLines.length);
    }
    this.invalidate();
  }

  private splitOutput(output: string): string[] {
    return (output.length > 0 ? sanitizeShellOutput(output) : '[no output captured]').split('\n');
  }

  protected renderHeaderLine(width: number): string {
    const title = currentTheme.boldFg('primary', ' Task output ');
    const id = currentTheme.boldFg('text', this.props.taskId);
    const info = this.props.info;
    const segments: string[] = [];
    if (info !== undefined) {
      segments.push(currentTheme.fg(statusColor(info.status), STATUS_LABEL[info.status]));
      if (info.kind === 'process' && info.exitCode !== null) {
        segments.push(currentTheme.fg('textMuted', `exit ${String(info.exitCode)}`));
      }
      if (info.description && info.description.length > 0) {
        segments.push(currentTheme.fg('textMuted', info.description));
      }
    }
    const composed = title + id + (segments.length > 0 ? '  ' + segments.join('  ') : '');
    return fitViewerLine(composed, width);
  }

  protected getBodyLines(): readonly string[] {
    const palette = currentTheme.palette;
    if (this.styledLines === undefined || this.styledPalette !== palette) {
      this.styledPalette = palette;
      this.styledLines = this.rawLines.map((line) => currentTheme.fg('text', line));
    }
    return this.styledLines;
  }

  protected getFooterItems(): readonly ViewerFooterItem[] {
    return [
      { keys: '↑↓', label: 'line' },
      { keys: 'PgUp/PgDn/Ctrl+U/D', label: 'page' },
      { keys: 'g/G', label: 'top/bot' },
      { keys: 'Q/Esc', label: 'cancel', onClick: () => this.props.onClose() },
    ];
  }

  protected onClose(): void {
    this.props.onClose();
  }
}

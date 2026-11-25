import type { Terminal } from '@moonshot-ai/pi-tui';
import type { BackgroundTaskInfo, BackgroundTaskStatus } from '@moonshot-ai/kimi-code-sdk';

import {
  ScreenTakeoverView,
  fitLineExactly,
  handleScrollViewerKey,
  scrollFooterHints,
  type FramedScrollPane,
} from '#/tui/components/chrome/screen-takeover-view';
import { currentTheme } from '#/tui/theme';
import { sanitizeShellOutput } from '#/tui/utils/shell-output';

export interface TaskOutputViewerProps {
  readonly taskId: string;
  readonly info: BackgroundTaskInfo | undefined;
  readonly output: string;
  readonly onClose: () => void;
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

export class TaskOutputViewer extends ScreenTakeoverView {
  private props: TaskOutputViewerProps;
  private lines: string[];
  private readonly pane: FramedScrollPane;

  constructor(props: TaskOutputViewerProps, terminal: Terminal) {
    super(terminal);
    this.props = props;
    this.lines = this.splitOutput(props.output);
    this.pane = this.mountSinglePane<'close'>({
      follow: 'end',
      initialPosition: 'start',
      renderHeader: (width) => this.renderHeader(width),
      renderContent: (width) => this.renderContent(width),
      footerHints: () => scrollFooterHints('PgUp/PgDn/Ctrl+U/D', 'Q/Esc', 'close'),
      onFooterAction: () => {
        this.props.onClose();
      },
    });
  }

  setProps(next: TaskOutputViewerProps): void {
    const previousOutput = this.props.output;
    this.props = next;
    if (next.output !== previousOutput) {
      this.lines = this.splitOutput(next.output);
    }
    this.invalidate();
  }

  private splitOutput(output: string): string[] {
    return (output.length > 0 ? sanitizeShellOutput(output) : '[no output captured]').split('\n');
  }

  handleInput(data: string): void {
    if (handleScrollViewerKey(this.pane.scrollView, data, { onClose: () => this.props.onClose() })) {
      this.invalidate();
    }
  }

  private renderContent(width: number): string[] {
    const innerWidth = Math.max(1, width);
    return this.lines.map((raw) => fitLineExactly(currentTheme.fg('text', raw), innerWidth));
  }

  private renderHeader(width: number): string {
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
    return fitLineExactly(composed, width);
  }
}

import { Container, Text } from '@moonshot-ai/pi-tui';

import { SHELL_OUTPUT_PREVIEW_LINES } from '#/tui/constant/rendering';
import { currentTheme } from '#/tui/theme';

import { formatBashOutputForDisplay, sanitizeShellOutput } from '#/tui/utils/shell-output';

import { TruncatedOutputComponent } from './tool-renderers/truncated';

const RUNNING_TAIL_LINES = 5;
const TIMER_INTERVAL_MS = 1000;
const MAX_COMBINED_CHARS = 256 * 1024;
const KEEP_COMBINED_CHARS = 64 * 1024;

const TRUNCATED_RUNNING_NOTICE = '… (output truncated)';

export class ShellRunComponent extends Container {
  private readonly textComponent: Text;
  private finalOutput = '';
  private combined = '';
  private combinedTruncated = false;
  private running = true;
  private backgrounded = false;
  private disposed = false;
  private expanded = false;
  private runningHidesRows = false;
  private readonly startedAt = Date.now();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly requestRender: () => void) {
    super();
    this.textComponent = new Text(this.renderText(), 0, 0);
    this.addChild(this.textComponent);
    this.timer = setInterval(() => this.tick(), TIMER_INTERVAL_MS);
  }

  append(text: string): void {
    if (this.disposed || !this.running || text.length === 0) return;
    this.combined += text;
    if (this.combined.length > MAX_COMBINED_CHARS) {
      this.combined = this.combined.slice(-KEEP_COMBINED_CHARS);
      this.combinedTruncated = true;
    }
    this.flush();
  }

  finish(stdout: string, stderr: string, isError?: boolean): void {
    if (this.disposed || !this.running) return;
    this.running = false;
    this.clearTimer();
    this.finalOutput = formatBashOutputForDisplay(stdout, stderr, isError);
    this.rebuildResult();
    this.flush();
  }

  isExpanded(): boolean {
    return this.expanded;
  }

  hasHiddenContent(): boolean {
    if (this.disposed || this.backgrounded) return false;
    if (this.running) return this.runningHidesRows;
    return (
      this.finalOutput.split('\n').length > SHELL_OUTPUT_PREVIEW_LINES + 1 ||
      this.children.some(
        (child) => child instanceof TruncatedOutputComponent && child.wasTruncated(),
      )
    );
  }

  finishBackgrounded(): void {
    if (this.disposed || !this.running) return;
    this.running = false;
    this.backgrounded = true;
    this.clearTimer();
    this.flush();
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
  }

  setExpanded(expanded: boolean): void {
    if (this.disposed || this.expanded === expanded) return;
    this.expanded = expanded;
    if (this.running || this.backgrounded) {
      this.flush();
      return;
    }
    this.rebuildResult();
    this.flush();
  }

  private rebuildResult(): void {
    try {
      const next = new TruncatedOutputComponent(this.finalOutput, {
        expanded: this.expanded,
        isError: false,
        maxLines: SHELL_OUTPUT_PREVIEW_LINES,
        expandHint: true,
      });
      this.clear();
      this.addChild(next);
    } catch {}
  }

  private tick(): void {
    if (!this.running) return;
    this.flush();
  }

  private flush(): void {
    if (this.disposed) return;
    try {
      if (this.running || this.backgrounded) {
        this.textComponent.setText(this.renderText());
      }
      this.requestRender();
    } catch {}
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private renderText(): string {
    try {
      if (this.backgrounded) {
        return `  ${currentTheme.fg('textDim', 'Moved to background.')}`;
      }
      const elapsed = Math.floor((Date.now() - this.startedAt) / 1000);
      const dim = (s: string): string => currentTheme.fg('textDim', s);
      const trimmed = sanitizeShellOutput(this.combined).trimEnd();
      const lineCount = trimmed.length === 0 ? 0 : trimmed.split('\n').length;
      this.runningHidesRows = this.combinedTruncated || lineCount > RUNNING_TAIL_LINES;
      let body: string;
      let extra = 0;
      if (trimmed.length === 0) {
        body = `  ${dim('Running…')}`;
      } else if (this.expanded) {
        const notice = this.combinedTruncated ? `  ${dim(TRUNCATED_RUNNING_NOTICE)}\n` : '';
        body =
          notice +
          trimmed
            .split('\n')
            .map((line) => `  ${dim(line)}`)
            .join('\n');
      } else {
        const lines = trimmed.split('\n');
        const tail = lines.slice(-RUNNING_TAIL_LINES);
        extra = Math.max(0, lines.length - RUNNING_TAIL_LINES);
        body = tail.map((line) => `  ${dim(line)}`).join('\n');
      }
      const timing = `  ${dim(`${extra > 0 ? `+${extra} lines ` : ''}(${elapsed}s)`)}`;
      const hint = `  ${dim('(ctrl+b to run in background)')}`;
      return `${body}\n${timing}\n${hint}`;
    } catch {
      return '  (output unavailable)';
    }
  }
}

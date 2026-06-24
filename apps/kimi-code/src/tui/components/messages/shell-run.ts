import { Container, Text } from '@earendil-works/pi-tui';

import { currentTheme } from '#/tui/theme';

import { formatBashOutputForDisplay, stripAnsi } from '#/tui/utils/shell-output';

const RUNNING_TAIL_LINES = 5;
const TIMER_INTERVAL_MS = 1000;

/**
 * Live view for a user-initiated `!` shell command. Two phases:
 *
 *  - running: dim, ANSI-stripped tail of the combined output, a `+N lines`
 *    overflow marker, an elapsed `(Xs)` timer that ticks every second, and a
 *    `(ctrl+b to run in background)` hint — matching claude-code's running card
 *    so warnings are grey rather than red while the command works.
 *  - finished: the standard `formatBashOutputForDisplay` view (stderr red only
 *    on failure), the timer stopped and the running chrome removed.
 */
export class ShellRunComponent extends Container {
  private readonly textComponent: Text;
  private combined = '';
  private running = true;
  private backgrounded = false;
  private finalStdout = '';
  private finalStderr = '';
  private finalIsError?: boolean;
  private readonly startedAt = Date.now();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly requestRender: () => void) {
    super();
    this.textComponent = new Text(this.renderText(), 0, 0);
    this.addChild(this.textComponent);
    this.timer = setInterval(() => this.tick(), TIMER_INTERVAL_MS);
  }

  append(text: string): void {
    if (!this.running || text.length === 0) return;
    this.combined += text;
    this.flush();
  }

  finish(stdout: string, stderr: string, isError?: boolean): void {
    if (!this.running) return;
    this.running = false;
    this.finalStdout = stdout;
    this.finalStderr = stderr;
    this.finalIsError = isError;
    this.clearTimer();
    this.flush();
  }

  finishBackgrounded(): void {
    if (!this.running) return;
    this.running = false;
    this.backgrounded = true;
    this.clearTimer();
    this.flush();
  }

  dispose(): void {
    this.clearTimer();
  }

  private tick(): void {
    if (!this.running) return;
    this.flush();
  }

  private flush(): void {
    this.textComponent.setText(this.renderText());
    this.requestRender();
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private renderText(): string {
    if (this.backgrounded) {
      return `  ${currentTheme.fg('textDim', 'Moved to background.')}`;
    }
    if (!this.running) {
      return formatBashOutputForDisplay(this.finalStdout, this.finalStderr, this.finalIsError)
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n');
    }
    const elapsed = Math.floor((Date.now() - this.startedAt) / 1000);
    const dim = (s: string): string => currentTheme.fg('textDim', s);
    const trimmed = stripAnsi(this.combined).trimEnd();
    let body: string;
    let extra = 0;
    if (trimmed.length === 0) {
      body = `  ${dim('Running…')}`;
    } else {
      const lines = trimmed.split('\n');
      const tail = lines.slice(-RUNNING_TAIL_LINES);
      extra = Math.max(0, lines.length - RUNNING_TAIL_LINES);
      body = tail.map((line) => `  ${dim(line)}`).join('\n');
    }
    const timing = `  ${dim(`${extra > 0 ? `+${extra} lines ` : ''}(${elapsed}s)`)}`;
    const hint = `  ${dim('(ctrl+b to run in background)')}`;
    return `${body}\n${timing}\n${hint}`;
  }
}

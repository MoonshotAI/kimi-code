import { Container, Text } from '@moonshot-ai/pi-tui';

import { currentTheme } from '#/tui/theme';

import { formatBashOutputForDisplay, sanitizeShellOutput } from '#/tui/utils/shell-output';

import { FixedHeightWindow } from './fixed-height-window';

const RUNNING_TAIL_LINES = 5;
const TIMER_INTERVAL_MS = 1000;
// Cap the live running buffer so a command that spews output for minutes can't
// grow memory without bound or make every render re-strip a multi-MB string.
// Only affects the transient running tail; the final view uses the full
// captured stdout/stderr passed to finish().
const MAX_COMBINED_CHARS = 256 * 1024;
const KEEP_COMBINED_CHARS = 64 * 1024;

/**
 * Live view for a user-initiated `!` shell command. Two phases:
 *
 *  - running: dim, ANSI-stripped tail of the combined output, a `+N lines`
 *    overflow marker, an elapsed `(Xs)` timer that ticks every second, and a
 *    `(ctrl+b to run in background)` hint — matching claude-code's running card
 *    so warnings are grey rather than red while the command works.
 *  - finished: the standard `formatBashOutputForDisplay` view (stderr red only
 *    on failure), the timer stopped and the running chrome removed.
 *
 * Hardened so a misbehaving command can never crash the TUI: the running
 * buffer is capped, and every render/render-request path swallows errors.
 */
export class ShellRunComponent extends Container {
  private readonly textComponent: Text;
  private combined = '';
  private running = true;
  private backgrounded = false;
  private disposed = false;
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
    if (this.disposed || !this.running || text.length === 0) return;
    this.combined += text;
    if (this.combined.length > MAX_COMBINED_CHARS) {
      this.combined = this.combined.slice(-KEEP_COMBINED_CHARS);
    }
    this.flush();
  }

  finish(stdout: string, stderr: string, isError?: boolean): void {
    if (this.disposed || !this.running) return;
    this.running = false;
    this.finalStdout = stdout;
    this.finalStderr = stderr;
    this.finalIsError = isError;
    this.clearTimer();
    this.flush();
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

  private tick(): void {
    if (!this.running) return;
    this.flush();
  }

  private flush(): void {
    if (this.disposed) return;
    try {
      this.textComponent.setText(this.renderText());
      this.requestRender();
    } catch {
      // Never let a render/render-request error escape into a timer or event
      // handler — an uncaught exception there can take down the whole TUI.
    }
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

      if (!this.running) {
        // Finished: show the tail of the final output in the same fixed
        // window as the running view so the card height does not change.
        const allLines = formatBashOutputForDisplay(
          this.finalStdout,
          this.finalStderr,
          this.finalIsError,
        ).split('\n');
        const window = new FixedHeightWindow({
          height: RUNNING_TAIL_LINES,
          tail: true,
          lines: allLines,
        });
        const body = window
          .render(80)
          .map((line) => `  ${line}`)
          .join('\n');
        const hidden = Math.max(0, allLines.length - RUNNING_TAIL_LINES);
        const status = `  ${dim(
          `completed${hidden > 0 ? ` · +${String(hidden)} lines` : ''} · ctrl+o to expand`,
        )}`;
        return `${body}\n${status}\n `;
      }

      // Running: dim tail of the combined output + timing + hint.
      const trimmed = sanitizeShellOutput(this.combined).trimEnd();
      const allLines = trimmed.length === 0 ? ['Running…'] : trimmed.split('\n');
      const window = new FixedHeightWindow({
        height: RUNNING_TAIL_LINES,
        tail: true,
        lines: allLines,
      });
      const body = window
        .render(80)
        .map((line) => `  ${dim(line)}`)
        .join('\n');
      const extra = Math.max(0, allLines.length - RUNNING_TAIL_LINES);
      const timing = `  ${dim(`${extra > 0 ? `+${String(extra)} lines ` : ''}(${String(elapsed)}s)`)}`;
      const hint = `  ${dim('(ctrl+b to run in background)')}`;
      return `${body}\n${timing}\n${hint}`;
    } catch {
      return '  (output unavailable)';
    }
  }
}

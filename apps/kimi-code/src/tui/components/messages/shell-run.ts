import { Container, Text } from '@moonshot-ai/pi-tui';

import { SHELL_OUTPUT_PREVIEW_LINES } from '#/tui/constant/rendering';
import { currentTheme } from '#/tui/theme';

import { formatBashOutputForDisplay, sanitizeShellOutput } from '#/tui/utils/shell-output';

import { TruncatedOutputComponent } from './tool-renderers/truncated';

const RUNNING_TAIL_LINES = 5;
const TIMER_INTERVAL_MS = 1000;
// Cap the live running buffer so a command that spews output for minutes can't
// grow memory without bound or make every render re-strip a multi-MB string.
// Only affects the transient running tail; the final view uses the full
// captured stdout/stderr passed to finish(). When the cap drops older output,
// the expanded running view says so via TRUNCATED_RUNNING_NOTICE.
const MAX_COMBINED_CHARS = 256 * 1024;
const KEEP_COMBINED_CHARS = 64 * 1024;

const TRUNCATED_RUNNING_NOTICE = '... (output truncated)';

/**
 * Live view for a user-initiated `!` shell command. Two phases:
 *
 *  - running: dim, ANSI-stripped tail of the combined output (the last
 *    RUNNING_TAIL_LINES lines, or the whole buffer when expanded via
 *    ctrl+o), a `+N lines` overflow marker, an elapsed `(Xs)` timer that
 *    ticks every second, and a `(ctrl+b to run in background)` hint —
 *    matching claude-code's running card so warnings are grey rather than
 *    red while the command works.
 *  - finished: the standard `formatBashOutputForDisplay` view (stderr red only
 *    on failure) through the shared TruncatedOutputComponent — collapsed to
 *    the first SHELL_OUTPUT_PREVIEW_LINES visual rows, expanded to the full
 *    output by the global ctrl+o toggle.
 *
 * Hardened so a misbehaving command can never crash the TUI: the running
 * buffer is capped, and every render/render-request path swallows errors.
 */
export class ShellRunComponent extends Container {
  private readonly textComponent: Text;
  private finalOutput = '';
  private combined = '';
  private combinedTruncated = false;
  private running = true;
  private backgrounded = false;
  private disposed = false;
  private expanded = false;
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
    // Running and backgrounded views re-render in place; only a finished
    // card rebuilds its result component with the new state.
    if (this.running || this.backgrounded) {
      this.flush();
      return;
    }
    this.rebuildResult();
    this.flush();
  }

  // Rebuild-on-toggle, mirroring ToolCallComponent: the result component is
  // immutable, so a new expansion state means a new component instance.
  private rebuildResult(): void {
    try {
      // Build before clearing: if the constructor throws, the old view stays.
      const next = new TruncatedOutputComponent(this.finalOutput, {
        expanded: this.expanded,
        // The stream colours are already baked into the formatted text, so
        // the component must not re-colour the whole block as an error.
        isError: false,
        maxLines: SHELL_OUTPUT_PREVIEW_LINES,
        expandHint: true,
      });
      this.clear();
      this.addChild(next);
    } catch {
      // finish() runs in a promise continuation and setExpanded() in a key
      // handler — an escaping error would surface as an unhandled rejection
      // or take down the TUI.
    }
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
      const trimmed = sanitizeShellOutput(this.combined).trimEnd();
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

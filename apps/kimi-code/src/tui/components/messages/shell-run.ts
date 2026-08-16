import { Container, Text } from '@moonshot-ai/pi-tui';

import { currentTheme } from '#/tui/theme';
import type { TranscriptEntry } from '#/tui/types';

import { formatBashOutputForDisplay, sanitizeShellOutput } from '#/tui/utils/shell-output';

const RUNNING_TAIL_LINES = 5;
const TIMER_INTERVAL_MS = 1000;
// Cap the live running buffer so a command that spews output for minutes can't
// grow memory without bound or make every render re-strip a multi-MB string.
const MAX_COMBINED_CHARS = 256 * 1024;
// Also caps each stream in the completed tail so one long line cannot expand
// into an unbounded number of wrapped rows.
const KEEP_COMBINED_CHARS = 64 * 1024;

function outputTail(text: string): string {
  const cleaned = sanitizeShellOutput(text).trimEnd();
  if (cleaned.length === 0) return '';

  let start = cleaned.length;
  let cursor = cleaned.length;
  for (let lines = 0; lines < RUNNING_TAIL_LINES && cursor > 0; lines++) {
    const newline = cleaned.lastIndexOf('\n', cursor - 1);
    start = newline + 1;
    if (newline < 0) break;
    cursor = newline;
  }

  start = Math.max(start, cleaned.length - KEEP_COMBINED_CHARS);
  const firstCodePoint = cleaned.codePointAt(start);
  if (firstCodePoint !== undefined && firstCodePoint >= 0xdc00 && firstCodePoint <= 0xdfff) start++;

  let omittedLines = 0;
  for (let i = 0; i < start; i++) {
    if (cleaned[i] === '\n') omittedLines++;
  }

  if (start === 0) return cleaned;
  const hint =
    omittedLines > 0
      ? `... (${String(omittedLines)} earlier lines)`
      : '... (earlier output truncated)';
  return `${hint}\n${cleaned.slice(start)}`;
}

type ShellOutputDisplay = NonNullable<TranscriptEntry['shellOutputDisplay']>;

export function shellOutputDisplay(
  stdout: string,
  stderr: string,
  isError?: boolean,
): ShellOutputDisplay {
  return {
    stdoutTail: outputTail(stdout),
    stderrTail: outputTail(stderr),
    isError,
  };
}

function formatFinalOutput(stdoutTail: string, stderrTail: string, isError?: boolean): string {
  try {
    const formatted = formatBashOutputForDisplay(stdoutTail, stderrTail, isError);
    return `  ${formatted.replaceAll('\n', '\n  ')}`;
  } catch {
    return '  (output unavailable)';
  }
}

/**
 * Live view for a user-initiated `!` shell command. Two phases:
 *
 *  - running: dim, ANSI-stripped tail of the combined output, a `+N lines`
 *    overflow marker, an elapsed `(Xs)` timer that ticks every second, and a
 *    `(ctrl+b to run in background)` hint — matching claude-code's running card
 *    so warnings are grey rather than red while the command works.
 *  - finished: a bounded final tail (stderr red only on failure), with the
 *    timer stopped and the running chrome removed.
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

  constructor(
    private readonly requestRender: () => void,
    completed?: ShellOutputDisplay,
  ) {
    super();
    if (completed !== undefined) {
      this.running = false;
      this.finalStdout = completed.stdoutTail;
      this.finalStderr = completed.stderrTail;
      this.finalIsError = completed.isError;
    }
    this.textComponent = new Text(this.renderText(), 0, 0);
    this.addChild(this.textComponent);
    if (this.running) {
      this.timer = setInterval(() => {
        this.tick();
      }, TIMER_INTERVAL_MS);
    }
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
    const completed = shellOutputDisplay(stdout, stderr, isError);
    this.finalStdout = completed.stdoutTail;
    this.finalStderr = completed.stderrTail;
    this.finalIsError = completed.isError;
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

  override invalidate(): void {
    if (!this.disposed) {
      this.textComponent.setText(this.renderText());
    }
    super.invalidate();
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
      if (!this.running) {
        return formatFinalOutput(this.finalStdout, this.finalStderr, this.finalIsError);
      }
      const elapsed = Math.floor((Date.now() - this.startedAt) / 1000);
      const dim = (s: string): string => currentTheme.fg('textDim', s);
      const trimmed = sanitizeShellOutput(this.combined).trimEnd();
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
    } catch {
      return '  (output unavailable)';
    }
  }
}

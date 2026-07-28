import { MAX_TERMINAL_TITLE_LENGTH } from '#/tui/constant/terminal';
import {
  OFF_TITLE_SPINNER_ID,
  PHASE_TITLE_GLYPHS,
  PHASE_TITLE_SPINNER_ID,
  resolveTitleSpinnerId,
  TITLE_SPINNER_ENV,
  TITLE_SPINNER_STYLES,
  type TitleSpinnerStyle,
} from '#/tui/constant/title-spinners';

const TITLE_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export interface TerminalTitleSpinnerHost {
  /** Write the terminal title (OSC 0). */
  setTitle(label: string): void;
  /** Static title shown when idle (session title or product name). */
  staticTitle(): string;
  /** Whether the agent is currently busy (streaming a turn or compacting). */
  isBusy(): boolean;
  /** Current streaming phase. */
  streamingPhase(): string;
}

/**
 * Owns the terminal-title busy indicator: resolves the spinner style once,
 * animates the title while the agent is busy, and restores the static title
 * when idle or on shutdown. `KimiTUI` only calls `sync()` when the busy state
 * changes and `dispose()` on teardown; all style, timer, and frame state lives
 * here so the behavior stays independently testable.
 */
export class TerminalTitleSpinnerController {
  private readonly host: TerminalTitleSpinnerHost;
  private readonly spinnerId: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;

  constructor(
    host: TerminalTitleSpinnerHost,
    spinnerEnv: string | undefined = process.env[TITLE_SPINNER_ENV],
  ) {
    this.host = host;
    this.spinnerId = resolveTitleSpinnerId(spinnerEnv);
  }

  /** Reflect the current busy state on the terminal title. */
  sync(): void {
    if (!this.host.isBusy() || this.spinnerId === OFF_TITLE_SPINNER_ID) {
      this.stop();
      this.host.setTitle(this.host.staticTitle());
      return;
    }
    if (this.spinnerId === PHASE_TITLE_SPINNER_ID) {
      this.host.setTitle(this.phaseTitle());
      return;
    }
    const style = TITLE_SPINNER_STYLES[this.spinnerId];
    if (style === undefined) {
      this.host.setTitle(this.host.staticTitle());
      return;
    }
    this.host.setTitle(this.frameTitle(style));
    this.timer ??= setInterval(() => {
      this.frame = (this.frame + 1) % style.frames.length;
      this.host.setTitle(this.frameTitle(style));
    }, style.interval);
  }

  /** Stop animating and restore the static title (called on shutdown). */
  dispose(): void {
    this.stop();
    this.host.setTitle(this.host.staticTitle());
  }

  private stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private frameTitle(style: TitleSpinnerStyle): string {
    const frame = style.frames[this.frame % style.frames.length] ?? '';
    return this.fitTitle(`${frame} ${this.host.staticTitle()}`);
  }

  private phaseTitle(): string {
    const phase = this.host.streamingPhase();
    const base = this.host.staticTitle();
    // Own-property check only: an inherited key such as `constructor` must
    // not be stringified into the title.
    const glyph = Object.hasOwn(PHASE_TITLE_GLYPHS, phase) ? PHASE_TITLE_GLYPHS[phase] : undefined;
    return glyph === undefined ? base : this.fitTitle(`${glyph} ${base}`);
  }

  /** Keep the composed title within the terminal-title cap. */
  private fitTitle(title: string): string {
    if (title.length <= MAX_TERMINAL_TITLE_LENGTH) return title;
    // Truncate on grapheme boundaries so multi-code-point characters (emoji,
    // flags, ZWJ sequences) are dropped whole rather than split mid-cluster.
    let fitted = '';
    for (const { segment } of TITLE_SEGMENTER.segment(title)) {
      if (fitted.length + segment.length > MAX_TERMINAL_TITLE_LENGTH) break;
      fitted += segment;
    }
    return fitted;
  }
}

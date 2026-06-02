/**
 * `/dance` easter egg — everything it needs lives in this one file: the
 * rainbow text coloring, the animation state machine, and the command handler.
 * Removing the feature is "delete this file + its import sites".
 *
 * It is deliberately NOT registered in BUILTIN_SLASH_COMMANDS, so it stays out
 * of `/help` and autocomplete; `executeSlashCommand` calls the handler as a
 * fallback after builtin/skill resolution, so a real command or a same-named
 * skill always wins.
 */

import chalk from 'chalk';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

import type { SlashCommandHost } from '../commands/dispatch';
import type { ParsedSlashInput } from '../commands/types';
import type { ColorPalette } from '../theme/colors';

/** Frame interval for the rainbow flow animation. */
export const DANCE_FRAME_MS = 110;
/** How long the rainbow flows before settling (fading out, or freezing). */
export const DANCE_FLOW_MS = 3000;

const DARK_RAINBOW = [
  '#4FA8FF',
  '#5BC0BE',
  '#4EC87E',
  '#E8A838',
  '#FFCB6B',
  '#C678B8',
  '#A274D9',
  '#7C8DFF',
] as const;

const LIGHT_RAINBOW = [
  '#1565C0',
  '#00838F',
  '#0E7A38',
  '#92660A',
  '#9A4A00',
  '#B91C1C',
  '#8A3A75',
  '#6B3A9A',
  '#354CB5',
] as const;

function getDanceRainbowPalette(colors: ColorPalette): readonly [string, ...string[]] {
  return colors.text === '#1A1A1A' ? LIGHT_RAINBOW : DARK_RAINBOW;
}

/** Paint a string character-by-character through a palette, skipping spaces. */
export function rainbowText(
  text: string,
  colors: readonly [string, ...string[]],
  offset = 0,
  bold = false,
): string {
  let colorIndex = offset;
  return Array.from(text)
    .map((char) => {
      if (char === ' ') return char;
      const color = colors[colorIndex % colors.length] ?? colors[0];
      colorIndex++;
      const style = chalk.hex(color);
      return bold ? style.bold(char) : style(char);
    })
    .join('');
}

/** Read-only view of the dance state for components that only render it. */
export interface RainbowDanceView {
  /** Whether consumers should paint themselves in rainbow at all. */
  readonly colored: boolean;
  /** Palette offset, advancing while the rainbow flows. */
  readonly phase: number;
}

export interface RainbowDanceController extends RainbowDanceView {
  start(opts: { hold: boolean }): void;
  stop(): void;
  dispose(): void;
}

let currentDanceController: RainbowDanceController | undefined;
let currentDanceView: RainbowDanceView | undefined;

export function setRainbowDance(dance: RainbowDanceController | undefined): void {
  currentDanceController = dance;
  currentDanceView = dance;
}

export function installRainbowDance(requestRender: () => void): () => void {
  currentDanceController?.dispose();
  const dance = new RainbowDance(requestRender);
  setRainbowDance(dance);
  return () => {
    dance.dispose();
    if (currentDanceController === dance) {
      setRainbowDance(undefined);
    }
  };
}

export function getRainbowDanceView(): RainbowDanceView | undefined {
  return currentDanceView;
}

export function isRainbowDancing(): boolean {
  return currentDanceView?.colored === true;
}

export function renderDanceWelcomeHeader(
  colors: ColorPalette,
  logo: readonly [string, string],
  textWidth: number,
  rightRow1: string,
): string[] {
  const phase = currentDanceView?.phase ?? 0;
  const palette = getDanceRainbowPalette(colors);
  const logoWidth = Math.max(...logo.map((row) => visibleWidth(row)));
  const gap = '  ';
  const rightRow0 = truncateToWidth(
    rainbowText('Welcome to Kimi Code!', palette, phase + 2, true),
    textWidth,
    '…',
  );

  return [
    rainbowText(logo[0].padEnd(logoWidth), palette, phase) + gap + rightRow0,
    rainbowText(logo[1].padEnd(logoWidth), palette, phase + 3) + gap + rightRow1,
  ];
}

export function renderDanceFooterModel(modelLabel: string, colors: ColorPalette): string {
  return rainbowText(modelLabel, getDanceRainbowPalette(colors), currentDanceView?.phase ?? 0);
}

/**
 * Drives the rainbow: a single timer advances a shared `phase` and asks the UI
 * to repaint. Lives independently of any component, so the welcome banner
 * scrolling away or being rebuilt never disturbs the animation. Three states:
 * off (default), flowing, and a frozen static rainbow.
 */
export class RainbowDance implements RainbowDanceController {
  private currentPhase = 0;
  private isColored = false;
  private frameTimer: ReturnType<typeof setInterval> | null = null;
  private flowStopTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly requestRender: () => void;

  constructor(requestRender: () => void) {
    this.requestRender = requestRender;
  }

  get colored(): boolean {
    return this.isColored;
  }

  get phase(): number {
    return this.currentPhase;
  }

  /**
   * Flow the rainbow for `DANCE_FLOW_MS`, then settle:
   *  - `hold: false` → fade back to the default (uncolored) banner.
   *  - `hold: true`  → freeze into a static rainbow that stays on.
   */
  start(opts: { hold: boolean }): void {
    this.clearTimers();
    this.isColored = true;
    this.frameTimer = setInterval(() => {
      // Phase just increments; rainbowText() takes it modulo the *current*
      // palette length, so the dance never needs to know the palette size.
      this.currentPhase += 1;
      this.requestRender();
    }, DANCE_FRAME_MS);
    this.flowStopTimer = setTimeout(() => {
      this.settle(opts.hold);
    }, DANCE_FLOW_MS);
    this.requestRender();
  }

  /** Turn the rainbow off — back to the default colors. */
  stop(): void {
    this.clearTimers();
    this.isColored = false;
    this.currentPhase = 0;
    this.requestRender();
  }

  /**
   * Clear timers without repainting — for shutdown, where the UI is going
   * away and a final render would be wasted or write to a stopped terminal.
   */
  dispose(): void {
    this.clearTimers();
  }

  /** End the flow: freeze the rainbow (hold) or fade back to default. */
  private settle(hold: boolean): void {
    this.clearTimers();
    if (!hold) {
      this.isColored = false;
      this.currentPhase = 0;
    }
    this.requestRender();
  }

  private clearTimers(): void {
    if (this.frameTimer !== null) {
      clearInterval(this.frameTimer);
      this.frameTimer = null;
    }
    if (this.flowStopTimer !== null) {
      clearTimeout(this.flowStopTimer);
      this.flowStopTimer = null;
    }
  }
}

/**
 * Handle `/dance`:
 *   /dance       flow for a few seconds, then fade back to the default colors
 *   /dance on    flow, then freeze into a static rainbow that stays on
 *   /dance off   turn the rainbow off
 *
 * Returns true when it claimed the input.
 */
export function tryHandleDanceCommand(host: SlashCommandHost, parsed: ParsedSlashInput): boolean {
  if (parsed.name !== 'dance') return false;
  if (currentDanceController === undefined) return false;

  // The status line dims the whole message, which buried the command in the
  // hint. Paint just the command in the brand color (bold) so it reads as a
  // command; chalk nesting resumes the dim run right after it.
  const cmd = (text: string): string => chalk.hex(host.state.theme.colors.primary).bold(text);

  const sub = parsed.args.trim().toLowerCase();
  if (sub === 'off') {
    currentDanceController.stop();
  } else if (sub === 'on') {
    currentDanceController.start({ hold: true });
    host.showStatus(`Dancing — use ${cmd('/dance off')} to turn it off.`);
  } else {
    currentDanceController.start({ hold: false });
    host.showStatus(`Use ${cmd('/dance on')} to keep the rainbow on.`);
  }
  return true;
}

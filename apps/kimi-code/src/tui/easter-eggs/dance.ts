import chalk from 'chalk';
import { truncateToWidth, visibleWidth } from '@moonshot-ai/pi-tui';

import type { SlashCommandHost } from '../commands/dispatch';
import type { ParsedSlashInput } from '../commands/types';
import { currentTheme } from '../theme';

export const DANCE_FRAME_MS = 110;
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

function getDanceRainbowPalette(): readonly [string, ...string[]] {
  return currentTheme.palette.text === '#1A1A1A' ? LIGHT_RAINBOW : DARK_RAINBOW;
}

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

export interface RainbowDanceView {
  readonly colored: boolean;
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
  logo: readonly [string, string],
  textWidth: number,
  rightRow1: string,
): string[] {
  const phase = currentDanceView?.phase ?? 0;
  const palette = getDanceRainbowPalette();
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

export function renderDanceFooterModel(modelLabel: string): string {
  return rainbowText(modelLabel, getDanceRainbowPalette(), currentDanceView?.phase ?? 0);
}

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

  start(opts: { hold: boolean }): void {
    this.clearTimers();
    this.isColored = true;
    this.frameTimer = setInterval(() => {
      this.currentPhase += 1;
      this.requestRender();
    }, DANCE_FRAME_MS);
    this.flowStopTimer = setTimeout(() => {
      this.settle(opts.hold);
    }, DANCE_FLOW_MS);
    this.requestRender();
  }

  stop(): void {
    this.clearTimers();
    this.isColored = false;
    this.currentPhase = 0;
    this.requestRender();
  }

  dispose(): void {
    this.clearTimers();
  }

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

export function tryHandleDanceCommand(host: SlashCommandHost, parsed: ParsedSlashInput): boolean {
  if (parsed.name !== 'dance') return false;
  if (currentDanceController === undefined) return false;

  const cmd = (text: string): string => currentTheme.boldFg('primary', text);

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

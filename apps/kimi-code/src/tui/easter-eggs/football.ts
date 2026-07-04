/**
 * `/football` easter egg — everything it needs lives in this one file: the
 * one-shot kick animation, the "loader is now a football" flag, and the
 * command handler. Removing the feature is "delete this file + its import
 * sites".
 *
 * Like `/dance`, it is deliberately NOT registered in BUILTIN_SLASH_COMMANDS,
 * so it stays out of `/help` and autocomplete; `executeSlashCommand` calls the
 * handler as a fallback after builtin/skill resolution, so a real command or a
 * same-named skill always wins. `footerball` is accepted as a typo-tolerant
 * alias.
 */

import type { Container, TUI } from '@moonshot-ai/pi-tui';

import type { SlashCommandHost } from '../commands/dispatch';
import type { ParsedSlashInput } from '../commands/types';
import { MoonLoader } from '../components/chrome/moon-loader';
import { currentTheme } from '../theme';

/** How long the football spins before settling into the tip line. */
export const FOOTBALL_KICK_MS = 2200;

let footballActive = false;
let currentKick: FootballKick | undefined;

/** Whether the session's moon loader should render as a spinning football. */
export function isFootballActive(): boolean {
  return footballActive;
}

export function setFootballActive(active: boolean): void {
  footballActive = active;
}

/** The easter-egg tip shown once the kick animation settles. */
export function footballTipLine(): string {
  const cmd = (text: string): string => currentTheme.boldFg('primary', text);
  return `⚽  Goooal! Easter egg unlocked — the moon loader is now a spinning football. Use ${cmd('/football off')} to revert.`;
}

/**
 * A one-shot football animation: a spinning football in the transcript that
 * settles into the easter-egg tip after `FOOTBALL_KICK_MS`. It reuses the
 * `MoonLoader` with the `football` style, so the kick previews exactly what the
 * loader will look like.
 */
export class FootballKick {
  private readonly loader: MoonLoader;
  private readonly container: Container;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private settled = false;

  constructor(ui: TUI, container: Container) {
    this.container = container;
    this.loader = new MoonLoader(ui, 'football');
    this.container.addChild(this.loader);
  }

  /** Begin the spin; the loader is already spinning from its constructor. */
  start(): void {
    this.settleTimer = setTimeout(() => {
      this.settle();
    }, FOOTBALL_KICK_MS);
  }

  /** Stop the spin and freeze on the easter-egg tip line. */
  settle(): void {
    if (this.settled) return;
    this.settled = true;
    if (this.settleTimer !== null) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    this.loader.stop();
    this.loader.setText(footballTipLine());
  }

  /**
   * Clear timers without rendering the tip — for shutdown or when a newer
   * `/football` supersedes this one. Removes the still-spinning loader so no
   * half-finished frame is left behind.
   */
  dispose(): void {
    if (this.settleTimer !== null) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    this.loader.stop();
    if (!this.settled) {
      // pi-tui Container.removeChild (not a DOM node); `child.remove()` does not exist.
      // oxlint-disable-next-line unicorn/prefer-dom-node-remove
      this.container.removeChild(this.loader);
    }
  }
}

/** Drop the in-flight kick, if any. Safe to call when idle. */
export function disposeFootballKick(): void {
  currentKick?.dispose();
  currentKick = undefined;
}

/**
 * Handle `/football`:
 *   /football        play the kick animation and turn the moon loader into a football
 *   /football off    bring the moon loader back
 *
 * (`footerball` is accepted as a typo-tolerant alias.)
 *
 * Returns true when it claimed the input.
 */
export function tryHandleFootballCommand(
  host: SlashCommandHost,
  parsed: ParsedSlashInput,
): boolean {
  if (parsed.name !== 'football' && parsed.name !== 'footerball') return false;

  const sub = parsed.args.trim().toLowerCase();
  if (sub === 'off') {
    setFootballActive(false);
    disposeFootballKick();
    host.showStatus('The moon loader is back.');
    return true;
  }

  setFootballActive(true);
  // Supersede any in-flight kick so repeated `/football` doesn't stack
  // half-finished animations in the transcript.
  disposeFootballKick();
  const kick = new FootballKick(host.state.ui, host.state.transcriptContainer);
  currentKick = kick;
  kick.start();
  host.state.ui.requestRender();
  return true;
}

import { basename } from 'node:path';

import {
  matchesKey,
  Key,
  truncateToWidth,
  type Component,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@moonshot-ai/pi-tui';
import chalk from 'chalk';

import { currentTheme } from '#/tui/theme';
import type { ColorPalette } from '#/tui/theme/colors';
import { ListMouseTracker } from '#/tui/utils/mouse-regions';

import {
  candidatesWithin,
  IMPORT_BATCH_LIMIT,
  IMPORT_WINDOW_DAYS,
  type ImportCandidate,
  type ImportProgress,
  type ImportReport,
  type ImportScan,
} from './run-import';

type Phase = 'scanning' | 'choose' | 'importing' | 'done' | 'failed';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
const SPINNER_INTERVAL_MS = 80;
const SOURCE_LABELS = { 'claude-code': 'Claude Code', codex: 'Codex' } as const;
const MAX_LISTED_FAILURES = 3;
const LONGEST_WINDOW_DAYS = Math.max(...IMPORT_WINDOW_DAYS);

export interface ImportSessionsScreenOptions {
  readonly now: number;
  readonly scan: () => Promise<ImportScan>;
  readonly run: (
    candidates: readonly ImportCandidate[],
    hooks: { readonly onProgress: (progress: ImportProgress) => void; readonly shouldStop: () => boolean },
  ) => Promise<ImportReport>;
  readonly onClose: (report: ImportReport | undefined) => void;
  readonly requestRender?: () => void;
  readonly colors?: ColorPalette;
}

interface Choice {
  readonly label: string;
  readonly days?: number;
}

function sessions(count: number): string {
  return `${String(count)} session${count === 1 ? '' : 's'}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ImportSessionsScreenComponent implements Component, Focusable {
  focused = false;
  private readonly options: ImportSessionsScreenOptions;
  private readonly mouse = new ListMouseTracker<number>();
  private phase: Phase = 'scanning';
  private scan: ImportScan | undefined;
  private selectedIndex = 0;
  private progress: ImportProgress | undefined;
  private stopRequested = false;
  private report: ImportReport | undefined;
  private failure: string | undefined;
  private spinnerFrame = 0;
  private spinnerTimer: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  constructor(options: ImportSessionsScreenOptions) {
    this.options = options;
    this.startSpinner();
    void options.scan().then(
      (scan) => {
        this.scan = scan;
        this.selectedIndex = this.count(IMPORT_WINDOW_DAYS[0]) === 0 && this.count(IMPORT_WINDOW_DAYS[1]) > 0 ? 1 : 0;
        this.transitionPhase('choose');
        this.settle();
      },
      (error: unknown) => {
        this.failure = errorMessage(error);
        this.transitionPhase('failed');
        this.settle();
      },
    );
  }

  invalidate(): void {}

  handleInput(data: string): void {
    const cancel = matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'));
    if (this.phase === 'scanning') {
      if (cancel) this.close();
      return;
    }
    if (this.phase === 'importing') {
      if (cancel && !this.stopRequested) {
        this.stopRequested = true;
        this.requestRender();
      }
      return;
    }
    if (this.phase === 'done' || this.phase === 'failed') {
      if (cancel || matchesKey(data, Key.enter)) this.close();
      return;
    }
    const choices = this.choices();
    if (cancel) {
      this.close();
    } else if (matchesKey(data, Key.up)) {
      this.selectedIndex = (this.selectedIndex - 1 + choices.length) % choices.length;
      this.requestRender();
    } else if (matchesKey(data, Key.down)) {
      this.selectedIndex = (this.selectedIndex + 1) % choices.length;
      this.requestRender();
    } else if (matchesKey(data, Key.enter)) {
      this.activateChoice(this.selectedIndex);
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.closed) return undefined;
    if (this.phase === 'choose') {
      return this.mouse.handle(event, {
        focused: this.focused,
        onHover: (index) => this.selectChoice(index),
        onActivate: (index) => {
          this.activateChoice(index);
        },
      });
    }
    if (this.phase === 'done' || this.phase === 'failed') {
      return this.mouse.handle(event, {
        focused: this.focused,
        onActivate: () => {
          this.close();
        },
      });
    }
    return this.mouse.handle(event, { focused: this.focused });
  }

  render(width: number): string[] {
    this.mouse.reset();
    const colors = this.options.colors ?? currentTheme.palette;
    const title =
      this.phase === 'importing'
        ? 'Importing sessions'
        : this.phase === 'done' || this.phase === 'failed'
          ? 'Session import'
          : 'Import sessions from Claude Code and Codex';
    const lines = [
      chalk.hex(colors.primary)('─'.repeat(width)),
      chalk.hex(colors.primary).bold(` ${title}`),
      '',
    ];
    this.appendBody(lines, colors);
    lines.push(chalk.hex(colors.primary)('─'.repeat(width)));
    if (this.phase === 'done' || this.phase === 'failed') {
      this.mouse.add(0, lines.length, 0);
    }
    return lines.map((line) => truncateToWidth(line, width));
  }

  private appendBody(lines: string[], colors: ColorPalette): void {
    const text = chalk.hex(colors.text);
    const muted = chalk.hex(colors.textMuted);
    const spinner = chalk.hex(colors.accent)(SPINNER_FRAMES[this.spinnerFrame] ?? SPINNER_FRAMES[0]);
    switch (this.phase) {
      case 'scanning':
        lines.push(`  ${spinner}  ${text('Scanning Claude Code and Codex sessions…')}`, '', muted(' esc cancel'));
        return;
      case 'choose':
        this.appendChooseBody(lines, colors);
        return;
      case 'importing': {
        const progress = this.progress;
        const current =
          progress === undefined
            ? 'Preparing…'
            : `${String(progress.index + 1)}/${String(progress.total)} · ${basename(progress.candidate.cwd)} (${SOURCE_LABELS[progress.candidate.source]})`;
        lines.push(
          `  ${spinner}  ${text(current)}`,
          '',
          muted(this.stopRequested ? ' Stopping after the current session…' : ' esc stops after the current session; imported sessions are kept'),
        );
        return;
      }
      case 'done':
        lines.push(...this.reportBody(colors));
        return;
      case 'failed':
        lines.push(chalk.hex(colors.error)(` Import failed: ${this.failure ?? 'unknown error'}`), '', muted(' enter close'));
    }
  }

  private appendChooseBody(lines: string[], colors: ColorPalette): void {
    const text = chalk.hex(colors.text);
    const muted = chalk.hex(colors.textMuted);
    const choices = this.choices();
    const alreadyImported = this.scan?.alreadyImported ?? 0;
    const missingFolder = this.scan?.missingFolder ?? 0;
    const notCounted = [
      ...(alreadyImported > 0 ? [`${String(alreadyImported)} already imported`] : []),
      ...(missingFolder > 0 ? [`${String(missingFolder)} with a missing project folder`] : []),
    ];
    const pushChoices = (): void => {
      for (const [index, choice] of choices.entries()) {
        this.mouse.track(lines, index, () => {
          const selected = index === this.selectedIndex;
          const pointer = chalk.hex(selected ? colors.primary : colors.textDim)(`  ${selected ? '❯' : ' '} `);
          const label = (selected ? chalk.hex(colors.primary).bold : text)(choice.label.padEnd(14));
          if (choice.days === undefined) {
            lines.push(pointer + label);
            return;
          }
          const count = this.count(choice.days);
          const limit = count > IMPORT_BATCH_LIMIT ? ` · newest ${String(IMPORT_BATCH_LIMIT)} this run` : '';
          lines.push(pointer + label + muted(`${sessions(count)}${limit}`));
        });
      }
    };
    if (this.count(LONGEST_WINDOW_DAYS) === 0) {
      const reasons = notCounted.length > 0 ? ` ${notCounted.join(', ')}.` : '';
      lines.push(text(` No sessions from the last ${String(LONGEST_WINDOW_DAYS)} days to import.${reasons}`), '');
      pushChoices();
      lines.push('', muted(' enter close'));
      return;
    }
    const recent = candidatesWithin(this.scan!, LONGEST_WINDOW_DAYS, this.options.now);
    const bySource = (['claude-code', 'codex'] as const)
      .map((source) => [SOURCE_LABELS[source], recent.filter((candidate) => candidate.source === source).length] as const)
      .filter(([, count]) => count > 0)
      .map(([label, count]) => `${label} ${String(count)}`);
    const summary = [...bySource, ...(notCounted.length > 0 ? [`not counted: ${notCounted.join(', ')}`] : [])];
    lines.push(text(' Sessions are converted locally; source files are not changed.'), '');
    pushChoices();
    lines.push('', muted(` ${summary.join(' · ')}`), muted(' ↑/↓ move · enter select · esc cancel'));
  }

  private reportBody(colors: ColorPalette): string[] {
    const report = this.report!;
    const text = chalk.hex(colors.text);
    const muted = chalk.hex(colors.textMuted);
    const headline = report.stopped
      ? `Import stopped. Imported ${sessions(report.imported.length)}.`
      : report.imported.length > 0
        ? `Imported ${sessions(report.imported.length)}.`
        : 'No sessions were imported.';
    const skipped = [
      [report.missingFolder, 'with a missing project folder'],
      [report.inUse, 'still in use (run the import again later)'],
      [report.unsupported, 'forked or restarted in Codex (not supported yet)'],
      [report.empty, 'without a prompt'],
      [report.alreadyImported, 'already imported'],
    ] as const;
    const skippedTotal = skipped.reduce((total, [count]) => total + count, 0);
    const lines = [chalk.hex(report.imported.length > 0 ? colors.success : colors.text)(` ${headline}`)];
    if (skippedTotal > 0) {
      lines.push(text(` Skipped ${String(skippedTotal)}:`));
      for (const [count, reason] of skipped) {
        if (count > 0) lines.push(muted(`   ${String(count)} ${reason}`));
      }
    }
    if (report.failed.length > 0) {
      lines.push(chalk.hex(colors.warning)(` Failed ${String(report.failed.length)}:`));
      for (const failure of report.failed.slice(0, MAX_LISTED_FAILURES)) {
        lines.push(muted(`   ${basename(failure.path)}: ${failure.message}`));
      }
      if (report.failed.length > MAX_LISTED_FAILURES) {
        lines.push(muted(`   and ${String(report.failed.length - MAX_LISTED_FAILURES)} more`));
      }
    }
    if (report.imported.length > 0) {
      lines.push('', muted(' Find them with /sessions; ctrl+a shows all projects.'));
    }
    return [...lines, '', muted(' enter close')];
  }

  private choices(): Choice[] {
    if (this.count(LONGEST_WINDOW_DAYS) === 0) return [{ label: 'Close' }];
    return [...IMPORT_WINDOW_DAYS.map((days) => ({ label: `Last ${String(days)} days`, days })), { label: 'Cancel' }];
  }

  private count(days: number): number {
    return this.scan === undefined ? 0 : candidatesWithin(this.scan, days, this.options.now).length;
  }

  private selectChoice(index: number): boolean {
    const count = this.choices().length;
    if (index < 0 || index >= count || this.selectedIndex === index) return false;
    this.selectedIndex = index;
    return true;
  }

  private activateChoice(index: number): void {
    const choice = this.choices()[index];
    if (choice === undefined) return;
    this.selectedIndex = index;
    if (choice.days === undefined) this.close();
    else this.start(choice.days);
  }

  private transitionPhase(phase: Phase): void {
    this.phase = phase;
    this.mouse.reset();
    this.mouse.resetSettling();
    if (phase === 'done' || phase === 'failed') {
      this.mouse.add(0, Number.MAX_SAFE_INTEGER, 0);
    }
  }

  private start(days: number): void {
    const candidates = candidatesWithin(this.scan!, days, this.options.now);
    this.transitionPhase('importing');
    this.startSpinner();
    this.requestRender();
    void this.options
      .run(candidates, {
        onProgress: (progress) => {
          this.progress = progress;
          this.requestRender();
        },
        shouldStop: () => this.stopRequested,
      })
      .then(
        (report) => {
          this.report = report;
          this.transitionPhase('done');
        },
        (error: unknown) => {
          this.failure = errorMessage(error);
          this.transitionPhase('failed');
        },
      )
      .finally(() => {
        this.settle();
      });
  }

  private settle(): void {
    this.stopSpinner();
    this.requestRender();
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopSpinner();
    this.options.onClose(this.report);
  }

  private startSpinner(): void {
    if (this.spinnerTimer !== undefined) return;
    this.spinnerTimer = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
      this.requestRender();
    }, SPINNER_INTERVAL_MS);
    this.spinnerTimer.unref();
  }

  private stopSpinner(): void {
    if (this.spinnerTimer === undefined) return;
    clearInterval(this.spinnerTimer);
    this.spinnerTimer = undefined;
  }

  private requestRender(): void {
    this.options.requestRender?.();
  }
}

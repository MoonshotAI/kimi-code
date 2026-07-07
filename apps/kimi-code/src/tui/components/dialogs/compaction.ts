/**
 * Renders a compaction block in the transcript.
 *
 * Lifecycle:
 *   - constructed on `compaction.started` → blinking white bullet +
 *     "Compacting context..." and optional custom instruction
 *   - `markDone()` on `compaction.completed` → solid green bullet +
 *     "Compaction complete (X → Y tokens)"
 *   - `markCanceled()` on `compaction.cancelled` → solid warning bullet +
 *     "Compaction cancelled"
 *
 * Bullet animation mirrors `ToolCallComponent` (500ms blink) so the user
 * reads the same "work in progress" signal across the UI.
 */

import { Container, Text, Spacer } from '@moonshot-ai/pi-tui';
import type { TUI } from '@moonshot-ai/pi-tui';

import { STATUS_BULLET } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';

const BLINK_INTERVAL = 500;

export class CompactionComponent extends Container {
  private readonly ui: TUI | undefined;
  private readonly headerText: Text;
  private instructionText: Text | undefined;
  private readonly instruction: string | undefined;
  private readonly tip: string | undefined;
  private blinkOn = true;
  private blinkTimer: ReturnType<typeof setInterval> | null = null;
  private done = false;
  private canceled = false;
  private tokensBefore: number | undefined;
  private tokensAfter: number | undefined;
  private summary: string | undefined;
  private summaryText: Text | undefined;
  private expanded = false;

  constructor(ui?: TUI, instruction?: string | undefined, tip?: string) {
    super();
    this.ui = ui;
    this.instruction = instruction;
    this.tip = tip;

    // Top margin so the block isn't glued to the previous transcript
    // entry (status line, tool result, etc.).
    this.addChild(new Spacer(1));
    this.headerText = new Text(this.buildHeader(), 0, 0);
    this.addChild(this.headerText);
    this.addInstructionChild();

    this.startBlink();
  }

  private addInstructionChild(): void {
    if (this.instruction !== undefined) {
      this.instructionText = new Text(currentTheme.dim(`  ${this.instruction}`), 0, 0);
      this.addChild(this.instructionText);
    }
  }

  private removeInstructionChild(): void {
    if (this.instructionText === undefined) return;
    const index = this.children.indexOf(this.instructionText);
    if (index !== -1) {
      this.children.splice(index, 1);
    }
    this.instructionText = undefined;
  }

  override invalidate(): void {
    // Repaint the header with the active palette (it caches ANSI codes).
    this.headerText.setText(this.buildHeader());
    // Rebuild instruction and summary text with fresh theme colours, preserving
    // header → instruction → summary child order.
    const expanded = this.expanded;
    this.removeInstructionChild();
    if (expanded) {
      this.removeSummaryChild();
    }
    this.addInstructionChild();
    if (expanded) {
      this.addSummaryChild();
    }
    super.invalidate();
  }

  markDone(tokensBefore?: number, tokensAfter?: number, summary?: string): void {
    if (this.done || this.canceled) return;
    this.done = true;
    this.tokensBefore = tokensBefore;
    this.tokensAfter = tokensAfter;
    this.summary = summary;
    this.stopBlink();
    this.headerText.setText(this.buildHeader());
    if (this.expanded) {
      this.addSummaryChild();
    }
    this.ui?.requestRender();
  }

  markCanceled(): void {
    if (this.done || this.canceled) return;
    this.canceled = true;
    this.stopBlink();
    this.headerText.setText(this.buildHeader());
    this.ui?.requestRender();
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    if (expanded) {
      this.addSummaryChild();
    } else {
      this.removeSummaryChild();
    }
    this.headerText.setText(this.buildHeader());
    this.ui?.requestRender();
  }

  private addSummaryChild(): void {
    if (this.summaryText !== undefined || this.summary === undefined || this.summary.length === 0) {
      return;
    }
    const indentedSummary = this.summary
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n');
    this.summaryText = new Text(currentTheme.dim(indentedSummary), 0, 0);
    this.addChild(this.summaryText);
  }

  private removeSummaryChild(): void {
    if (this.summaryText === undefined) return;
    const index = this.children.indexOf(this.summaryText);
    if (index !== -1) {
      this.children.splice(index, 1);
    }
    this.summaryText = undefined;
  }

  dispose(): void {
    this.stopBlink();
  }

  private buildHeader(): string {
    if (this.done) {
      const bullet = currentTheme.fg('success', STATUS_BULLET);
      const label = currentTheme.boldFg('success', 'Compaction complete');
      const detail =
        this.tokensBefore !== undefined && this.tokensAfter !== undefined
          ? currentTheme.dim(` (${String(this.tokensBefore)} → ${String(this.tokensAfter)} tokens)`)
          : '';
      const shortcutHint =
        this.summary !== undefined && this.summary.length > 0
          ? currentTheme.dim(` (Ctrl-O to ${this.expanded ? 'hide' : 'show'} compaction summary)`)
          : '';
      return `${bullet}${label}${detail}${shortcutHint}`;
    }
    if (this.canceled) {
      const bullet = currentTheme.fg('warning', STATUS_BULLET);
      const label = currentTheme.boldFg('warning', 'Compaction cancelled');
      return `${bullet}${label}`;
    }
    const bullet = this.blinkOn ? currentTheme.fg('text', STATUS_BULLET) : '  ';
    const label = currentTheme.boldFg('primary', 'Compacting context...');
    const tip = this.tip ? currentTheme.fg('textDim', ` · Tip: ${this.tip}`) : '';
    return `${bullet}${label}${tip}`;
  }

  private startBlink(): void {
    this.blinkTimer = setInterval(() => {
      this.blinkOn = !this.blinkOn;
      this.headerText.setText(this.buildHeader());
      this.ui?.requestRender();
    }, BLINK_INTERVAL);
  }

  private stopBlink(): void {
    if (this.blinkTimer !== null) {
      clearInterval(this.blinkTimer);
      this.blinkTimer = null;
    }
  }
}

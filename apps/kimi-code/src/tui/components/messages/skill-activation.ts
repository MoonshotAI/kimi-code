/**
 * Skill activation card.
 *
 * When the user runs `/skill:foo bar`, the TUI renders a compact card instead
 * of expanding the SKILL.md body into the user bubble:
 *
 *   ▶ Activated skill: foo
 *     bar
 *
 * The args line is optional. Core expands the skill body into the LLM context;
 * the TUI only consumes the `skill.activated` event and user_message origin
 * metadata.
 */

import { Container, Text, Spacer } from '@moonshot-ai/pi-tui';

import { currentTheme } from '#/tui/theme';
import type { SkillActivationTrigger } from '#/tui/types';

const ARGS_PREVIEW_MAX = 200;

export class SkillActivationComponent extends Container {
  private headText: Text;
  private previewText?: Text;
  private name: string;
  private args?: string;

  constructor(
    name: string,
    args: string | undefined,
    readonly trigger?: SkillActivationTrigger,
  ) {
    super();
    this.name = name;
    this.args = args;
    this.addChild(new Spacer(1));
    const head =
      currentTheme.boldFg('primary', '▶ Activated skill: ') +
      currentTheme.boldFg('roleUser', name);
    this.headText = new Text(head, 0, 0);
    this.addChild(this.headText);
    const trimmed = args?.trim() ?? '';
    if (trimmed.length > 0) {
      const preview =
        trimmed.length > ARGS_PREVIEW_MAX ? trimmed.slice(0, ARGS_PREVIEW_MAX) + '…' : trimmed;
      this.previewText = new Text('  ' + currentTheme.fg('textDim', preview), 0, 0);
      this.addChild(this.previewText);
    }
  }

  override invalidate(): void {
    const head =
      currentTheme.boldFg('primary', '▶ Activated skill: ') +
      currentTheme.boldFg('roleUser', this.name);
    this.headText.setText(head);
    if (this.previewText !== undefined && this.args !== undefined) {
      const trimmed = this.args.trim();
      const preview =
        trimmed.length > ARGS_PREVIEW_MAX ? trimmed.slice(0, ARGS_PREVIEW_MAX) + '…' : trimmed;
      this.previewText.setText('  ' + currentTheme.fg('textDim', preview));
    }
    super.invalidate();
  }
}

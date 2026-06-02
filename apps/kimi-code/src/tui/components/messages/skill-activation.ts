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

import { Container, Text, Spacer } from '@earendil-works/pi-tui';
import chalk from 'chalk';

import type { ColorPalette } from '#/tui/theme/colors';
import type { SkillActivationTrigger } from '#/tui/types';

const ARGS_PREVIEW_MAX = 200;

export class SkillActivationComponent extends Container {
  constructor(
    name: string,
    args: string | undefined,
    colors: ColorPalette,
    readonly trigger?: SkillActivationTrigger,
  ) {
    super();
    this.addChild(new Spacer(1));
    const head =
      chalk.hex(colors.primary).bold('▶ Activated skill: ') + chalk.hex(colors.roleUser).bold(name);
    this.addChild(new Text(head, 0, 0));
    const trimmed = args?.trim() ?? '';
    if (trimmed.length > 0) {
      const preview =
        trimmed.length > ARGS_PREVIEW_MAX ? trimmed.slice(0, ARGS_PREVIEW_MAX) + '…' : trimmed;
      this.addChild(new Text('  ' + chalk.hex(colors.textDim)(preview), 0, 0));
    }
  }
}

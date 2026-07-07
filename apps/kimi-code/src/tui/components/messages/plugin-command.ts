/**
 * Plugin command invocation card.
 *
 * When the user runs `/plugin:command args`, the TUI renders a compact card
 * instead of expanding the command body into the user bubble:
 *
 *   ▶ /plugin:command
 *     args
 *
 * The args line is optional. Core expands the command body into the LLM
 * context; the TUI only consumes the `plugin_command.activated` event.
 */

import { Container, Text, Spacer } from '@moonshot-ai/pi-tui';

import { currentTheme } from '#/tui/theme';

const ARGS_PREVIEW_MAX = 200;

export class PluginCommandComponent extends Container {
  private headText: Text;
  private previewText?: Text;
  private readonly label: string;
  private readonly args?: string;

  constructor(pluginId: string, commandName: string, args?: string) {
    super();
    this.label = `/${pluginId}:${commandName}`;
    this.args = args;
    this.addChild(new Spacer(1));
    const head =
      currentTheme.boldFg('primary', '▶ Invoked command: ') +
      currentTheme.boldFg('roleUser', this.label);
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
      currentTheme.boldFg('primary', '▶ Invoked command: ') +
      currentTheme.boldFg('roleUser', this.label);
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

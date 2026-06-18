/**
 * English translations for CLI-facing notices.
 *
 * The `cli` namespace carries the highest-value command-line messages that may
 * render before the TUI mounts — currently the `tui.toml` config-parse notice.
 * Keep `cli.config.invalidTuiConfig` in sync with `INVALID_TUI_CONFIG_MESSAGE`
 * in `#/tui/config`; that constant stays the English source used for logs and
 * issue triage, while this entry is what the user sees in the active locale.
 */

import type { MessageTree } from '../../i18n';

export const cli: MessageTree = {
  config: {
    invalidTuiConfig: 'Invalid TUI config in ~/.kimi-code/tui.toml; using defaults.',
  },
};

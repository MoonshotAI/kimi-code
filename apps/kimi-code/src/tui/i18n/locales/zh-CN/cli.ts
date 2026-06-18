/**
 * Simplified Chinese translations for CLI-facing notices.
 *
 * Mirrors the namespace structure and keys of `locales/en/cli.ts`. The file
 * path stays in code; only the surrounding notice is translated.
 */

import type { MessageTree } from '../../i18n';

export const cli: MessageTree = {
  config: {
    invalidTuiConfig: '~/.kimi-code/tui.toml 中的 TUI 配置无效，已使用默认值。',
  },
};

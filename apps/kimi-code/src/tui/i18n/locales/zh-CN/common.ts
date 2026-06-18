/**
 * Simplified Chinese translations for shared short phrases.
 *
 * Mirrors the namespace structure and keys of `locales/en/common.ts`. Keyboard
 * tokens (↑↓ / Enter / Esc / Backspace) stay in code; only the surrounding
 * action words are translated.
 */

import type { MessageTree } from '../../i18n';

export const common: MessageTree = {
  submit: '提交',
  cancel: '取消',
  back: '返回',
  hints: {
    navigate: '↑↓ 导航',
    select: 'Enter 选择',
    cancel: 'Esc 取消',
    clearSearch: 'Backspace 清除',
  },
};

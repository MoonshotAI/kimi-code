/**
 * English translations for short phrases shared across components.
 *
 * The `common` namespace holds the generic dialog-control vocabulary
 * (`common.submit` / `cancel` / `back`) plus the keyboard-hint phrases
 * (`common.hints.*`) that recur in list-style dialog footers. Keeping them
 * here means a shared phrase is translated once and reused everywhere, rather
 * than duplicated per component. Keep keys stable — they are the
 * contributor-facing contract shared with every locale.
 */

import type { MessageTree } from '../../i18n';

export const common: MessageTree = {
  submit: 'Submit',
  cancel: 'Cancel',
  back: 'Back',
  hints: {
    navigate: '↑↓ navigate',
    select: 'Enter select',
    cancel: 'Esc cancel',
    clearSearch: 'Backspace clear',
  },
};

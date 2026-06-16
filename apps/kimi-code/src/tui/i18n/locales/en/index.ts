/**
 * English language pack.
 *
 * Merges the per-module namespace files into a single message tree for the
 * `en` locale.
 */

import type { MessageTree } from '../../i18n';

import { components } from './components';

export const en: MessageTree = {
  components,
};

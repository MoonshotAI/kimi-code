/**
 * Simplified Chinese language pack.
 *
 * Merges the per-module namespace files into a single message tree for the
 * `zh-CN` locale.
 */

import type { MessageTree } from '../../i18n';

import { components } from './components';

export const zhCN: MessageTree = {
  components,
};

/**
 * English language pack.
 *
 * Merges the per-module namespace files into a single message tree for the
 * `en` locale.
 */

import type { MessageTree } from '../../i18n';

import { cli } from './cli';
import { commands } from './commands';
import { common } from './common';
import { components } from './components';
import { reverseRpc } from './reverse-rpc';

export const en: MessageTree = {
  cli,
  commands,
  common,
  components,
  reverseRpc,
};

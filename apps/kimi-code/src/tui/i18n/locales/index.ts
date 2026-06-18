/**
 * Bundled language packs keyed by locale.
 */

import type { LocaleMessages } from '../i18n';

import { en } from './en';
import { zhCN } from './zh-CN';

export const locales: LocaleMessages = {
  en,
  'zh-CN': zhCN,
};

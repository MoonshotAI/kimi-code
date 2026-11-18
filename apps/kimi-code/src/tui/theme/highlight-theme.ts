import { plain } from 'cli-highlight';
import type { Theme } from 'cli-highlight';

import { currentTheme } from './theme';

export const codeHighlightTheme: Theme = {
  string: plain,
  regexp: plain,
  addition: (code) => currentTheme.fg('diffAdded', code),
  deletion: (code) => currentTheme.fg('diffRemoved', code),
};

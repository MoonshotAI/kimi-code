
import type { ComposerKeymapResolver } from '@moonshot-ai/app-client/contracts';
import { matchBinding } from './keymap';
import { resolvedBinding } from '../composables/useShortcuts';

export const desktopComposerKeymapResolver: ComposerKeymapResolver = (action, ctx) => {
  if (action === 'newline') {
    const binding = resolvedBinding('composer.newline');
    return binding === null ? null : { matches: (e) => matchBinding(e, binding) };
  }
  if (action === 'send') {
    const binding = resolvedBinding('composer.send');
    if (binding === null) return null;
    if (binding === 'enter') {
      return {
        matches: (e) =>
          matchBinding(e, 'mod+enter') ||
          matchBinding(e, 'ctrl+enter') ||
          (!ctx.expanded && matchBinding(e, 'enter')),
      };
    }
    return { matches: (e) => matchBinding(e, binding) };
  }
  const newlineBinding = resolvedBinding('composer.newline');
  return newlineBinding === 'shift+enter' ? null : { matches: (e) => matchBinding(e, 'shift+enter') };
};

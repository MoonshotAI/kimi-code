

import { isApplePlatform } from './shortcutKeys';

export interface SessionSearchKeyEventLike {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  defaultPrevented: boolean;
}

export function isSessionSearchKeyEvent(
  event: SessionSearchKeyEventLike,
  apple: boolean = isApplePlatform(),
): boolean {
  const searchModifier = apple
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
  return (
    searchModifier &&
    !event.altKey &&
    !event.shiftKey &&
    (event.code === 'KeyK' || event.key.toLowerCase() === 'k') &&
    !event.defaultPrevented
  );
}

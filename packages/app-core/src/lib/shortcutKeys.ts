export type ShortcutKeys = readonly string[] | string;

export interface ShortcutKeyCap {
  name: string;
  text: string;
  icon?: string;
  spokenKey?: string;
}

interface KeySpec {
  text: string;
  icon?: string;
  spokenKey?: string;
}

const MODIFIER_ORDER = ['ctrl', 'alt', 'shift', 'mod'] as const;
const MODIFIER_NAMES: ReadonlySet<string> = new Set(MODIFIER_ORDER);

const APPLE_MODIFIERS: Record<string, KeySpec> = {
  mod: { text: '⌘', icon: 'key-command', spokenKey: 'shortcuts.keys.command' },
  ctrl: { text: '⌃', icon: 'key-control', spokenKey: 'shortcuts.keys.control' },
  alt: { text: '⌥', icon: 'key-option', spokenKey: 'shortcuts.keys.option' },
  shift: { text: '⇧', icon: 'key-shift', spokenKey: 'shortcuts.keys.shift' },
};

const OTHER_MODIFIERS: Record<string, KeySpec> = {
  mod: { text: 'Ctrl' },
  ctrl: { text: 'Ctrl' },
  alt: { text: 'Alt' },
  shift: { text: 'Shift' },
};

const KEYS: Record<string, KeySpec> = {
  enter: { text: '↵', icon: 'key-enter', spokenKey: 'shortcuts.keys.enter' },
  tab: { text: '⇥', icon: 'key-tab', spokenKey: 'shortcuts.keys.tab' },
  backspace: { text: '⌫', icon: 'key-backspace', spokenKey: 'shortcuts.keys.backspace' },
  plus: { text: '+', icon: 'key-plus', spokenKey: 'shortcuts.keys.plus' },
  arrowup: { text: '↑', icon: 'key-arrow-up', spokenKey: 'shortcuts.keys.arrowUp' },
  arrowdown: { text: '↓', icon: 'key-arrow-down', spokenKey: 'shortcuts.keys.arrowDown' },
  arrowleft: { text: '←', icon: 'key-arrow-left', spokenKey: 'shortcuts.keys.arrowLeft' },
  arrowright: { text: '→', icon: 'key-arrow-right', spokenKey: 'shortcuts.keys.arrowRight' },
  escape: { text: 'Esc' },
  space: { text: 'Space' },
  delete: { text: 'Del' },
  insert: { text: 'Ins' },
  home: { text: 'Home' },
  end: { text: 'End' },
  pageup: { text: 'PgUp' },
  pagedown: { text: 'PgDn' },
};

export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  if (/Mac|iPod|iPhone|iPad/.test(navigator.platform)) return true;
  const userAgentData = (navigator as Navigator & { userAgentData?: { platform?: string } })
    .userAgentData;
  return userAgentData?.platform === 'macOS' || userAgentData?.platform === 'iOS';
}

export function bindingKeyNames(binding: string): string[] {
  const tokens = binding.split('+').filter((token) => token !== '');
  const keys = tokens.filter((token) => !MODIFIER_NAMES.has(token));
  if (keys.length !== 1) return [];
  return [...MODIFIER_ORDER.filter((modifier) => tokens.includes(modifier)), keys[0]!];
}

export function shortcutKeyNames(keys: ShortcutKeys): string[] {
  return typeof keys === 'string' ? bindingKeyNames(keys) : [...keys];
}

export function formatShortcutKey(name: string, apple: boolean = isApplePlatform()): ShortcutKeyCap {
  const spec = (apple ? APPLE_MODIFIERS : OTHER_MODIFIERS)[name] ?? KEYS[name];
  if (spec !== undefined) return { name, ...spec };
  return { name, text: name.length === 1 ? name.toUpperCase() : name };
}

export function formatShortcutKeys(
  keys: ShortcutKeys,
  apple: boolean = isApplePlatform(),
): ShortcutKeyCap[] {
  return shortcutKeyNames(keys).map((name) => formatShortcutKey(name, apple));
}

export function formatShortcutText(keys: ShortcutKeys, apple: boolean = isApplePlatform()): string[] {
  return formatShortcutKeys(keys, apple).map((cap) => cap.text);
}

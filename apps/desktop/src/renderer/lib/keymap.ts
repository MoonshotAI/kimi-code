import { isApplePlatform } from '@moonshot-ai/app-core/shortcut-keys';

import {
  SHORTCUT_ACTION_IDS,
  type ShortcutActionId,
} from '../../shared/action-ids';

export type ShortcutScope = 'global' | 'composer' | 'conversation';

export interface ShortcutAction {
  id: ShortcutActionId;
  scope: ShortcutScope;
  labelKey: string;
  descKey: string;
  defaultBinding: string | null;
  extraBindings?: readonly string[];
  requiresSession?: boolean;
}

const SHORTCUT_ACTION_DEFINITIONS: Record<
  ShortcutActionId,
  Omit<ShortcutAction, 'id'>
> = {
  summonApp: { scope: 'global', labelKey: 'shortcuts.actions.summonApp.label', descKey: 'shortcuts.actions.summonApp.desc', defaultBinding: 'shift+mod+space' },
  captureScreenshot: { scope: 'global', labelKey: 'shortcuts.actions.captureScreenshot.label', descKey: 'shortcuts.actions.captureScreenshot.desc', defaultBinding: 'shift+mod+s' },
  newSession: { scope: 'global', labelKey: 'shortcuts.actions.newSession.label', descKey: 'shortcuts.actions.newSession.desc', defaultBinding: 'mod+n' },
  closeSessionView: { scope: 'global', labelKey: 'shortcuts.actions.closeSessionView.label', descKey: 'shortcuts.actions.closeSessionView.desc', defaultBinding: 'mod+w' },
  searchSessions: { scope: 'global', labelKey: 'shortcuts.actions.searchSessions.label', descKey: 'shortcuts.actions.searchSessions.desc', defaultBinding: 'mod+k' },
  archiveSession: { scope: 'global', labelKey: 'shortcuts.actions.archiveSession.label', descKey: 'shortcuts.actions.archiveSession.desc', defaultBinding: 'alt+mod+a', requiresSession: true },
  toggleSideChat: { scope: 'global', labelKey: 'shortcuts.actions.toggleSideChat.label', descKey: 'shortcuts.actions.toggleSideChat.desc', defaultBinding: 'alt+mod+b', requiresSession: true },
  toggleSidebar: { scope: 'global', labelKey: 'shortcuts.actions.toggleSidebar.label', descKey: 'shortcuts.actions.toggleSidebar.desc', defaultBinding: 'mod+b' },
  toggleRightPanel: { scope: 'global', labelKey: 'shortcuts.actions.toggleRightPanel.label', descKey: 'shortcuts.actions.toggleRightPanel.desc', defaultBinding: 'shift+mod+b' },
  openFolder: { scope: 'global', labelKey: 'shortcuts.actions.openFolder.label', descKey: 'shortcuts.actions.openFolder.desc', defaultBinding: 'mod+o' },
  openInDefaultApp: { scope: 'global', labelKey: 'shortcuts.actions.openInDefaultApp.label', descKey: 'shortcuts.actions.openInDefaultApp.desc', defaultBinding: 'alt+mod+o', requiresSession: true },
  openSettings: { scope: 'global', labelKey: 'shortcuts.actions.openSettings.label', descKey: 'shortcuts.actions.openSettings.desc', defaultBinding: 'mod+,' },
  toggleTerminal: { scope: 'global', labelKey: 'shortcuts.actions.toggleTerminal.label', descKey: 'shortcuts.actions.toggleTerminal.desc', defaultBinding: 'ctrl+`' },
  nextPanelTab: { scope: 'global', labelKey: 'shortcuts.actions.nextPanelTab.label', descKey: 'shortcuts.actions.nextPanelTab.desc', defaultBinding: 'ctrl+tab' },
  previousPanelTab: { scope: 'global', labelKey: 'shortcuts.actions.previousPanelTab.label', descKey: 'shortcuts.actions.previousPanelTab.desc', defaultBinding: 'ctrl+shift+tab' },
  openDiffTab: { scope: 'global', labelKey: 'shortcuts.actions.openDiffTab.label', descKey: 'shortcuts.actions.openDiffTab.desc', defaultBinding: 'ctrl+shift+g', requiresSession: true },
  toggleFilesPanel: { scope: 'global', labelKey: 'shortcuts.actions.toggleFilesPanel.label', descKey: 'shortcuts.actions.toggleFilesPanel.desc', defaultBinding: 'shift+mod+e' },
  sidebarTabOpen: { scope: 'global', labelKey: 'shortcuts.actions.sidebarTabOpen.label', descKey: 'shortcuts.actions.sidebarTabOpen.desc', defaultBinding: 'shift+mod+o' },
  sidebarTabDone: { scope: 'global', labelKey: 'shortcuts.actions.sidebarTabDone.label', descKey: 'shortcuts.actions.sidebarTabDone.desc', defaultBinding: 'shift+mod+d' },
  sidebarTabWorkspaces: { scope: 'global', labelKey: 'shortcuts.actions.sidebarTabWorkspaces.label', descKey: 'shortcuts.actions.sidebarTabWorkspaces.desc', defaultBinding: 'shift+mod+w' },
  selectPrevSibling: { scope: 'global', labelKey: 'shortcuts.actions.selectPrevSibling.label', descKey: 'shortcuts.actions.selectPrevSibling.desc', defaultBinding: 'shift+mod+[' },
  selectNextSibling: { scope: 'global', labelKey: 'shortcuts.actions.selectNextSibling.label', descKey: 'shortcuts.actions.selectNextSibling.desc', defaultBinding: 'shift+mod+]' },
  'composer.send': { scope: 'composer', labelKey: 'shortcuts.actions.send.label', descKey: 'shortcuts.actions.send.desc', defaultBinding: 'enter', extraBindings: ['mod+enter', 'ctrl+enter'] },
  'composer.newline': { scope: 'composer', labelKey: 'shortcuts.actions.newline.label', descKey: 'shortcuts.actions.newline.desc', defaultBinding: 'shift+enter' },
};

export const SHORTCUT_ACTIONS: readonly ShortcutAction[] = SHORTCUT_ACTION_IDS.map((id) => ({
  id,
  ...SHORTCUT_ACTION_DEFINITIONS[id],
}));

export function shortcutActionById(id: string): ShortcutAction | undefined {
  return SHORTCUT_ACTIONS.find((action) => action.id === id);
}

export interface ParsedBinding {
  mod: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

const MODIFIER_TOKENS = new Set(['mod', 'ctrl', 'alt', 'shift']);

const KEY_ALIASES: Record<string, string> = {
  ' ': 'space',
  spacebar: 'space',
  space: 'space',
  '+': 'plus',
  plus: 'plus',
  enter: 'enter',
  escape: 'escape',
  esc: 'escape',
  tab: 'tab',
  backspace: 'backspace',
  delete: 'delete',
  insert: 'insert',
  home: 'home',
  end: 'end',
  pageup: 'pageup',
  pagedown: 'pagedown',
  arrowup: 'arrowup',
  arrowdown: 'arrowdown',
  arrowleft: 'arrowleft',
  arrowright: 'arrowright',
};

export function normalizeEventKey(key: string): string | null {
  if (key === 'Meta' || key === 'Control' || key === 'Shift' || key === 'Alt') return null;
  const lowered = key.toLowerCase();
  const alias = KEY_ALIASES[lowered];
  if (alias !== undefined) return alias;
  if (key.length === 1) return lowered;
  if (/^f([1-9]|1[0-2])$/.test(lowered)) return lowered;
  return null;
}

const CODE_PUNCT: Record<string, string> = {
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
  NumpadAdd: 'plus',
};

function keyNameFromCode(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter !== null) return (letter[1] as string).toLowerCase();
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  if (digit !== null) return digit[1] as string;
  const punct = CODE_PUNCT[code];
  if (punct !== undefined) return punct;
  return normalizeEventKey(code);
}

export interface ShortcutKeyEvent {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  getModifierState?: (modifier: string) => boolean;
}

function keyNameFromEvent(e: ShortcutKeyEvent): string | null {
  if (typeof e.code === 'string' && e.code !== '') {
    const fromCode = keyNameFromCode(e.code);
    if (fromCode !== null) return fromCode;
  }
  return normalizeEventKey(e.key);
}

export function parseBinding(binding: string): ParsedBinding | null {
  const tokens = binding.split('+').filter((t) => t !== '');
  if (tokens.length === 0) return null;
  const parsed: ParsedBinding = { mod: false, ctrl: false, alt: false, shift: false, key: '' };
  for (const token of tokens) {
    if (MODIFIER_TOKENS.has(token)) {
      if (parsed[token as 'mod' | 'ctrl' | 'alt' | 'shift']) return null;
      parsed[token as 'mod' | 'ctrl' | 'alt' | 'shift'] = true;
      continue;
    }
    if (parsed.key !== '') return null;
    const key = normalizeEventKey(token);
    if (key === null) return null;
    parsed.key = key;
  }
  return parsed.key === '' ? null : parsed;
}

export function serializeBinding(parsed: ParsedBinding): string {
  const tokens: string[] = [];
  if (parsed.ctrl) tokens.push('ctrl');
  if (parsed.alt) tokens.push('alt');
  if (parsed.shift) tokens.push('shift');
  if (parsed.mod) tokens.push('mod');
  tokens.push(parsed.key);
  return tokens.join('+');
}

export function matchBinding(e: ShortcutKeyEvent, binding: string): boolean {
  if (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph')) return false;
  const parsed = parseBinding(binding);
  if (parsed === null) return false;
  const codeKey = typeof e.code === 'string' && e.code !== '' ? keyNameFromCode(e.code) : null;
  const key = codeKey ?? normalizeEventKey(e.key);
  if (key === null || key !== parsed.key) return false;

  const isApple = isApplePlatform();
  if (
    isApple &&
    parsed.alt &&
    !parsed.mod &&
    !parsed.ctrl &&
    e.altKey &&
    !e.metaKey &&
    !e.ctrlKey &&
    codeKey !== null &&
    normalizeEventKey(e.key) !== codeKey
  ) {
    return false;
  }

  const needMeta = isApple ? parsed.mod : false;
  const needCtrl = isApple ? parsed.ctrl : parsed.mod || parsed.ctrl;
  return (
    e.metaKey === needMeta &&
    e.ctrlKey === needCtrl &&
    e.altKey === parsed.alt &&
    e.shiftKey === parsed.shift
  );
}

export function bindingFromEvent(e: ShortcutKeyEvent): string | null {
  const key = keyNameFromEvent(e);
  if (key === null) return null;
  const isApple = isApplePlatform();
  return serializeBinding({
    mod: isApple ? e.metaKey : e.ctrlKey,
    ctrl: isApple ? e.ctrlKey : false,
    alt: e.altKey,
    shift: e.shiftKey,
    key,
  });
}

const BARE_ALLOWED_KEYS = new Set([
  'enter',
  'escape',
  'tab',
  'space',
  'backspace',
  'delete',
  'insert',
  'home',
  'end',
  'pageup',
  'pagedown',
  'arrowup',
  'arrowdown',
  'arrowleft',
  'arrowright',
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);

const F_KEYS = new Set(Array.from({ length: 12 }, (_, i) => `f${i + 1}`));

export function isValidBinding(binding: string, scope: ShortcutScope): boolean {
  const parsed = parseBinding(binding);
  if (parsed === null) return false;
  if (parsed.mod || parsed.ctrl) return true;
  if (parsed.alt) {
    if (isApplePlatform() && !BARE_ALLOWED_KEYS.has(parsed.key)) {
      return false;
    }
    return true;
  }
  if (scope === 'global') return F_KEYS.has(parsed.key);
  if (scope === 'composer') return parsed.key === 'enter';
  return BARE_ALLOWED_KEYS.has(parsed.key);
}

export const MENU_SYNCED_ACTIONS: readonly ShortcutActionId[] = [
  'openSettings',
  'newSession',
  'closeSessionView',
  'openFolder',
  'toggleTerminal',
];

export const OS_GLOBAL_ACTIONS: readonly ShortcutActionId[] = ['summonApp', 'captureScreenshot'];

function isNativeWideAction(id: string): boolean {
  return MENU_SYNCED_ACTIONS.some((actionId) => actionId === id) ||
    OS_GLOBAL_ACTIONS.some((actionId) => actionId === id);
}

export function isAltGrShapedBinding(binding: string): boolean {
  if (isApplePlatform()) return false;
  const parsed = parseBinding(binding);
  if (parsed === null) return false;
  return parsed.alt && (parsed.mod || parsed.ctrl);
}

export function isValidMenuBinding(binding: string): boolean {
  const parsed = parseBinding(binding);
  if (parsed === null) return false;
  if (!(parsed.mod || parsed.ctrl || parsed.alt)) return false;
  if (isAltGrShapedBinding(binding)) return false;
  return true;
}

const ACCELERATOR_EXPRESSIBLE_PUNCT = new Set([',', '.', '/', '\\', ';', '[', ']', '-', '=', '`']);

export function isAcceleratorExpressible(binding: string): boolean {
  const parsed = parseBinding(binding);
  if (parsed === null) return false;
  if (parsed.key.length !== 1) return true;
  return /^[a-z0-9]$/.test(parsed.key) || ACCELERATOR_EXPRESSIBLE_PUNCT.has(parsed.key);
}

const RESERVED_COMMON: readonly string[] = [
  'mod+z',
  'shift+mod+z',
  'mod+x',
  'mod+c',
  'mod+v',
  'mod+a',
  'mod+r',
  'mod+t',
  'mod+l',
  'shift+mod+r',
  'mod+0',
  'mod+-',
  'mod+=',
  'shift+mod+=',
  'mod+plus',
  'shift+mod+plus',
  'mod+w',
];

const RESERVED_NON_APPLE: readonly string[] = [
  ...RESERVED_COMMON,
  'shift+ctrl+i',
  'f11',
  'alt+f4',
  'shift+mod+v',
  'mod+y',
];

export const RESERVED_NATIVE_BINDINGS: {
  readonly apple: readonly string[];
  readonly other: readonly string[];
  readonly windows: readonly string[];
} = {
  apple: [
    ...RESERVED_COMMON,
    'mod+m',
    'alt+mod+i',
    'ctrl+mod+f',
    'mod+q',
    'mod+h',
    'alt+mod+h',
    'alt+shift+mod+v',
  ],
  other: [
    ...RESERVED_NON_APPLE,
    'mod+m',
  ],
  windows: [
    ...RESERVED_NON_APPLE,
    'alt+f',
    'alt+e',
    'alt+v',
    'alt+h',
  ],
};

const RESERVED_EXEMPTIONS: Readonly<Record<string, readonly string[]>> = {
  closeSessionView: ['mod+w'],
};

export function isReservedBinding(binding: string, actionId?: string): boolean {
  const windows =
    typeof navigator !== 'undefined' &&
    (navigator.platform.startsWith('Win') ||
      (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ===
        'Windows');
  const list = isApplePlatform()
    ? RESERVED_NATIVE_BINDINGS.apple
    : windows
      ? RESERVED_NATIVE_BINDINGS.windows
      : RESERVED_NATIVE_BINDINGS.other;
  const reserved = list.some((entry) =>
    bindingsEquivalent(entry, binding),
  );
  if (!reserved || actionId === undefined) return reserved;
  return !(RESERVED_EXEMPTIONS[actionId]?.some((exempt) => bindingsEquivalent(exempt, binding)) ?? false);
}

const RESERVED_BROWSER_COMMON: readonly string[] = [
  'mod+n',
  'mod+w',
  'shift+mod+w',
  'mod+o',
  'shift+mod+d',
  'shift+mod+[',
  'shift+mod+]',
  'ctrl+tab',
  'ctrl+shift+tab',
];

export const RESERVED_BROWSER_BINDINGS: {
  readonly apple: readonly string[];
  readonly other: readonly string[];
} = {
  apple: [...RESERVED_BROWSER_COMMON, 'alt+mod+b', 'mod+,'],
  other: [...RESERVED_BROWSER_COMMON, 'mod+k', 'shift+mod+o', 'shift+mod+b'],
};

export function isBrowserReservedBinding(binding: string): boolean {
  const list = isApplePlatform()
    ? RESERVED_BROWSER_BINDINGS.apple
    : RESERVED_BROWSER_BINDINGS.other;
  return list.some((entry) => bindingsEquivalent(entry, binding));
}

export const HARDCODED_BINDINGS: readonly string[] = ['ctrl+s', 'mod+s', 'ctrl+enter', 'mod+enter'];

export function isHardcodedBinding(binding: string): boolean {
  return HARDCODED_BINDINGS.some((hardcoded) => bindingsEquivalent(hardcoded, binding));
}

export const HARDCODED_FIND_BINDINGS: readonly string[] = ['mod+f'];

export function isHardcodedFindBinding(binding: string): boolean {
  return HARDCODED_FIND_BINDINGS.some((hardcoded) => bindingsEquivalent(hardcoded, binding));
}

export function bindingsEquivalent(a: string, b: string): boolean {
  const pa = parseBinding(a);
  const pb = parseBinding(b);
  if (pa === null || pb === null) return a === b;
  if (pa.key !== pb.key || pa.alt !== pb.alt || pa.shift !== pb.shift) return false;
  if (isApplePlatform()) {
    return pa.mod === pb.mod && pa.ctrl === pb.ctrl;
  }
  return (pa.mod || pa.ctrl) === (pb.mod || pb.ctrl);
}

export function effectiveBinding(
  action: ShortcutAction,
  overrides: Record<string, string | null>,
): string | null {
  const override = overrides[action.id];
  if (override !== undefined) return override;
  if (action.defaultBinding === null) return null;
  for (const other of SHORTCUT_ACTIONS) {
    if (other.id === action.id) continue;
    const otherOverride = overrides[other.id];
    if (otherOverride == null) continue;
    const competes =
      other.scope === action.scope || isNativeWideAction(other.id) || isNativeWideAction(action.id);
    if (competes && bindingsEquivalent(otherOverride, action.defaultBinding)) return null;
  }
  return action.defaultBinding;
}

export function findConflict(
  overrides: Record<string, string | null>,
  scope: ShortcutScope,
  binding: string,
  excludeId: string,
): string | null {
  const excludeIsNativeWide = isNativeWideAction(excludeId);
  for (const action of SHORTCUT_ACTIONS) {
    if (action.id === excludeId) continue;
    const crossesScopes = excludeIsNativeWide || isNativeWideAction(action.id);
    if (!crossesScopes && action.scope !== scope) continue;
    const effective = effectiveBinding(action, overrides);
    const owned =
      effective !== null && effective === action.defaultBinding
        ? [effective, ...(action.extraBindings ?? [])]
        : [effective];
    for (const candidate of owned) {
      if (candidate !== null && bindingsEquivalent(candidate, binding)) return action.id;
    }
  }
  return null;
}

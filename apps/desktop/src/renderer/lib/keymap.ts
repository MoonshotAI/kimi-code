// apps/desktop/src/renderer/lib/keymap.ts
// Desktop-only customizable keyboard shortcuts: the action registry plus the
// pure binding primitives (parse / match / record / validate / format) shared
// by the dispatcher (App.vue), the Composer, and the settings panel. No Vue
// imports here so the logic stays unit-testable; reactive state lives in
// composables/useShortcuts.ts. Web keeps its hardcoded keys (see
// docs/native-todos.md).
//
// Canonical binding format: modifiers in fixed order `ctrl/alt/shift/mod`
// (the macOS menu display order), then the key, joined with '+' — e.g.
// 'mod+,', 'shift+mod+a', 'alt+mod+s', 'enter', 'shift+enter', 'escape'.
// `mod` is the platform primary modifier: metaKey (⌘) on Apple platforms,
// ctrlKey elsewhere.

// ---------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------

/** True on macOS / iOS, where shortcuts use ⌘ (metaKey) as the primary
 *  modifier. Mirrors the heuristic that used to live in Sidebar.vue. */
export function isAppleShortcutPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  if (/Mac|iPod|iPhone|iPad/.test(navigator.platform)) return true;

  const userAgentData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return userAgentData?.platform === 'macOS' || userAgentData?.platform === 'iOS';
}

// ---------------------------------------------------------------------------
// Action registry
// ---------------------------------------------------------------------------

export type ShortcutScope = 'global' | 'composer' | 'conversation';

export interface ShortcutAction {
  id: string;
  scope: ShortcutScope;
  /** i18n keys under the `shortcuts` namespace. */
  labelKey: string;
  descKey: string;
  /** Canonical default binding; null = unassigned by default. */
  defaultBinding: string | null;
  /** Additional combos the action effectively owns while the DEFAULT binding
   *  is in effect (e.g. the expanded editor's send aliases) — conflict
   *  detection includes them so nothing else can claim them. */
  extraBindings?: readonly string[];
  /** True = the action operates on the current chat and only fires with an
   *  active session (never on the new-chat draft or onboarding pages). */
  requiresSession?: boolean;
}

// Registry order is the settings panel's display order (one flat list).
export const SHORTCUT_ACTIONS: readonly ShortcutAction[] = [
  // Global
  // summonApp is an OS-level global shortcut: the main process registers it
  // with globalShortcut and shows the window even from outside the app. It is
  // NOT dispatched through the renderer keydown (main/shortcuts.ts owns it).
  { id: 'summonApp', scope: 'global', labelKey: 'shortcuts.actions.summonApp.label', descKey: 'shortcuts.actions.summonApp.desc', defaultBinding: 'shift+mod+space' },
  { id: 'newSession', scope: 'global', labelKey: 'shortcuts.actions.newSession.label', descKey: 'shortcuts.actions.newSession.desc', defaultBinding: 'mod+n' },
  { id: 'searchSessions', scope: 'global', labelKey: 'shortcuts.actions.searchSessions.label', descKey: 'shortcuts.actions.searchSessions.desc', defaultBinding: 'mod+k' },
  { id: 'archiveSession', scope: 'global', labelKey: 'shortcuts.actions.archiveSession.label', descKey: 'shortcuts.actions.archiveSession.desc', defaultBinding: 'alt+mod+a', requiresSession: true },
  { id: 'toggleSideChat', scope: 'global', labelKey: 'shortcuts.actions.toggleSideChat.label', descKey: 'shortcuts.actions.toggleSideChat.desc', defaultBinding: 'alt+mod+b', requiresSession: true },
  { id: 'toggleSidebar', scope: 'global', labelKey: 'shortcuts.actions.toggleSidebar.label', descKey: 'shortcuts.actions.toggleSidebar.desc', defaultBinding: 'mod+b' },
  { id: 'openFolder', scope: 'global', labelKey: 'shortcuts.actions.openFolder.label', descKey: 'shortcuts.actions.openFolder.desc', defaultBinding: 'mod+o' },
  { id: 'openInDefaultApp', scope: 'global', labelKey: 'shortcuts.actions.openInDefaultApp.label', descKey: 'shortcuts.actions.openInDefaultApp.desc', defaultBinding: 'alt+mod+o', requiresSession: true },
  { id: 'openSettings', scope: 'global', labelKey: 'shortcuts.actions.openSettings.label', descKey: 'shortcuts.actions.openSettings.desc', defaultBinding: 'mod+,' },
  { id: 'toggleTerminal', scope: 'global', labelKey: 'shortcuts.actions.toggleTerminal.label', descKey: 'shortcuts.actions.toggleTerminal.desc', defaultBinding: 'ctrl+`' },
  // Composer (textarea-scoped). Steer (Ctrl/Cmd+S) and interrupt (Escape)
  // stay hardcoded in Composer.vue / ConversationPane.vue by decision —
  // they are NOT customizable and must not appear here.
  { id: 'composer.send', scope: 'composer', labelKey: 'shortcuts.actions.send.label', descKey: 'shortcuts.actions.send.desc', defaultBinding: 'enter', extraBindings: ['mod+enter', 'ctrl+enter'] },
  { id: 'composer.newline', scope: 'composer', labelKey: 'shortcuts.actions.newline.label', descKey: 'shortcuts.actions.newline.desc', defaultBinding: 'shift+enter' },
];

export function shortcutActionById(id: string): ShortcutAction | undefined {
  return SHORTCUT_ACTIONS.find((action) => action.id === id);
}

// ---------------------------------------------------------------------------
// Binding parsing / matching
// ---------------------------------------------------------------------------

export interface ParsedBinding {
  mod: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** Canonical key name: lowercase single char, or 'enter' / 'escape' / … */
  key: string;
}

const MODIFIER_TOKENS = new Set(['mod', 'ctrl', 'alt', 'shift']);

// e.key values → canonical key names. Printable single chars are lowercased;
// everything else must appear here to be bindable. '+' maps to 'plus' because
// the canonical format itself uses '+' as the token separator.
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

/** Normalize a KeyboardEvent key value to the canonical key name; null for
 *  pure modifier presses and anything we can't represent (dead keys etc.). */
export function normalizeEventKey(key: string): string | null {
  if (key === 'Meta' || key === 'Control' || key === 'Shift' || key === 'Alt') return null;
  const lowered = key.toLowerCase();
  const alias = KEY_ALIASES[lowered];
  if (alias !== undefined) return alias;
  if (key.length === 1) return lowered;
  if (/^f([1-9]|1[0-2])$/.test(lowered)) return lowered;
  return null;
}

// Physical-key (e.code) → canonical key name. Matching prefers e.code over
// e.key because macOS turns Option+letter into a DIFFERENT character in e.key
// (⌥A = 'å', ⌥B = '∫', ⌥O = 'ø'), which would never match an 'a'/'b'/'o'
// binding; e.code stays the physical key ('KeyA') regardless. Side effect:
// letters follow the QWERTY position on non-US layouts — accepted tradeoff.
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

/** Canonical key name from the event's physical code; null when the code is
 *  unknown (caller falls back to e.key). */
function keyNameFromCode(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter !== null) return (letter[1] as string).toLowerCase();
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  if (digit !== null) return digit[1] as string;
  const punct = CODE_PUNCT[code];
  if (punct !== undefined) return punct;
  // Named keys share the e.key alias table ('Enter' → 'enter', 'F5' → 'f5'…).
  return normalizeEventKey(code);
}

/** Minimal structural shape of the KeyboardEvent the matcher needs. Kept
 *  DOM-free on purpose: main-process tests import this module in the Node
 *  (non-DOM) typecheck program, and real KeyboardEvents satisfy it. */
export interface ShortcutKeyEvent {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  getModifierState?: (modifier: string) => boolean;
}

/** Event → canonical key name: physical code first (Option-combo proof),
 *  e.key as the fallback for exotic keys. */
function keyNameFromEvent(e: ShortcutKeyEvent): string | null {
  if (typeof e.code === 'string' && e.code !== '') {
    const fromCode = keyNameFromCode(e.code);
    if (fromCode !== null) return fromCode;
  }
  return normalizeEventKey(e.key);
}

/** Parse a canonical binding string; null when malformed. */
export function parseBinding(binding: string): ParsedBinding | null {
  const tokens = binding.split('+').filter((t) => t !== '');
  if (tokens.length === 0) return null;
  const parsed: ParsedBinding = { mod: false, ctrl: false, alt: false, shift: false, key: '' };
  for (const token of tokens) {
    if (MODIFIER_TOKENS.has(token)) {
      if (parsed[token as 'mod' | 'ctrl' | 'alt' | 'shift']) return null; // duplicate modifier
      parsed[token as 'mod' | 'ctrl' | 'alt' | 'shift'] = true;
      continue;
    }
    if (parsed.key !== '') return null; // two keys
    const key = normalizeEventKey(token);
    if (key === null) return null;
    parsed.key = key;
  }
  return parsed.key === '' ? null : parsed;
}

/** Serialize back to canonical form (fixed modifier order). */
export function serializeBinding(parsed: ParsedBinding): string {
  const tokens: string[] = [];
  if (parsed.ctrl) tokens.push('ctrl');
  if (parsed.alt) tokens.push('alt');
  if (parsed.shift) tokens.push('shift');
  if (parsed.mod) tokens.push('mod');
  tokens.push(parsed.key);
  return tokens.join('+');
}

/** True when the keyboard event exactly matches the binding: the modifier
 *  sets must be equal (an extra held modifier means no match, mirroring the
 *  old hardcoded checks like `!e.shiftKey && !e.altKey` on steer). */
export function matchBinding(e: ShortcutKeyEvent, binding: string): boolean {
  // AltGraph is text input, not a shortcut chord: many Windows/Linux layouts
  // report it as ctrl+alt (and Ctrl+Alt IS AltGr there), so without this
  // guard typing e.g. Polish 'ą' (AltGr+A) would match 'alt+mod+a' and
  // archive the chat. Safety over availability — on those layouts a
  // deliberate Ctrl+Alt binding simply never fires.
  if (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph')) return false;
  const parsed = parseBinding(binding);
  if (parsed === null) return false;
  const codeKey = typeof e.code === 'string' && e.code !== '' ? keyNameFromCode(e.code) : null;
  const key = codeKey ?? normalizeEventKey(e.key);
  if (key === null || key !== parsed.key) return false;

  const isApple = isAppleShortcutPlatform();
  // macOS Option is ALSO a text modifier when no ⌘/⌃ accompanies it:
  // Option+key produces a special character (å/ø/¡/…), transforming e.key
  // away from the physical key. A transformed event was the user typing,
  // not invoking a shortcut (same class as the AltGraph guard above; ⌘/⌃
  // held down marks a deliberate chord and is exempt).
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

  // `mod` resolves to metaKey on Apple, ctrlKey elsewhere; an explicit `ctrl`
  // token always means ctrlKey (only distinguishable on Apple — elsewhere it
  // collapses into the same flag as `mod`).
  const needMeta = isApple ? parsed.mod : false;
  const needCtrl = isApple ? parsed.ctrl : parsed.mod || parsed.ctrl;
  return (
    e.metaKey === needMeta &&
    e.ctrlKey === needCtrl &&
    e.altKey === parsed.alt &&
    e.shiftKey === parsed.shift
  );
}

/** Capture a binding from a keydown event (settings-panel recorder); null
 *  for pure modifier presses (user still holding keys / about to combo). */
export function bindingFromEvent(e: ShortcutKeyEvent): string | null {
  const key = keyNameFromEvent(e);
  if (key === null) return null;
  const isApple = isAppleShortcutPlatform();
  return serializeBinding({
    mod: isApple ? e.metaKey : e.ctrlKey,
    ctrl: isApple ? e.ctrlKey : false,
    alt: e.altKey,
    shift: e.shiftKey,
    key,
  });
}

// Bare (modifier-less) bindings must be non-printable keys, or normal typing
// would trigger the action.
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

/** A binding is assignable when it parses and carries a REAL shortcut
 *  modifier for printable keys: mod/ctrl/alt. Shift alone is a text
 *  modifier — a Shift+letter binding would eat normal uppercase typing —
 *  so Shift only combines with other modifiers or with non-printable keys
 *  (Shift+Enter, F-keys, arrows, …).
 *
 *  Global scope is stricter still: the dispatcher fires from anywhere a
 *  focused field didn't consume the key, so bare text-editing keys (Space,
 *  Backspace, arrows, …) would break ordinary typing — globals need a
 *  modifier or an F-key. Composer/conversation scopes keep the bare set
 *  (Enter / Shift+Enter / Escape need them). */
export function isValidBinding(binding: string, scope: ShortcutScope): boolean {
  const parsed = parseBinding(binding);
  if (parsed === null) return false;
  if (parsed.mod || parsed.ctrl) return true;
  if (parsed.alt) {
    // macOS Option is also a text modifier (Option+printable produces special
    // characters and matchBinding treats the transformed event as typing in
    // EVERY scope), so alt-only printable bindings are dead on arrival there
    // — the same class as AltGraph on Windows/Linux.
    if (isAppleShortcutPlatform() && !BARE_ALLOWED_KEYS.has(parsed.key)) {
      return false;
    }
    return true;
  }
  if (scope === 'global') return F_KEYS.has(parsed.key);
  // Composer bindings run straight from the textarea: every bare key except
  // Enter (and Shift+Enter) would hijack normal typing or a hardcoded local
  // behavior — Escape closes the composer's own menus, arrows move the
  // caret, Space/Backspace edit text.
  if (scope === 'composer') return parsed.key === 'enter';
  return BARE_ALLOWED_KEYS.has(parsed.key);
}

// ---------------------------------------------------------------------------
// Menu-backed actions & platform-aware equivalence
// ---------------------------------------------------------------------------

/** Actions that also exist as native menu items (main/menu.ts installs their
 *  bindings as app-wide menu accelerators via useShortcuts). Their reach is
 *  NOT limited to the renderer's scoped dispatcher, so conflict detection
 *  treats them as crossing every scope (in both directions). */
export const MENU_SYNCED_ACTIONS: readonly string[] = ['openSettings', 'newSession', 'openFolder', 'toggleTerminal'];

/** Actions the main process registers as OS-level global shortcuts
 *  (main/shortcuts.ts globalShortcut). Like menu accelerators, the OS
 *  intercepts the chord before the renderer ever sees it — even while the
 *  app is focused — so conflict detection must treat them as crossing every
 *  scope, and a binding Electron accelerators can't express has NO renderer
 *  fallback (the recorder rejects it via isAcceleratorExpressible). */
export const OS_GLOBAL_ACTIONS: readonly string[] = ['summonApp'];

/** True for every action whose binding is intercepted natively (menu
 *  accelerator or OS global shortcut) rather than by the renderer's scoped
 *  keydown dispatcher. */
function isNativeWideAction(id: string): boolean {
  return MENU_SYNCED_ACTIONS.includes(id) || OS_GLOBAL_ACTIONS.includes(id);
}

/** True on non-Apple platforms for chords shaped like AltGr (alt combined
 *  with mod/ctrl): Ctrl+Alt IS AltGr on many Windows/Linux layouts, so any
 *  NATIVE registration with that shape (menu accelerator, OS global
 *  shortcut) fires while the user types AltGr characters — before the
 *  renderer's AltGraph guard ever runs. Rejected at record time for every
 *  natively-registered action. */
export function isAltGrShapedBinding(binding: string): boolean {
  if (isAppleShortcutPlatform()) return false;
  const parsed = parseBinding(binding);
  if (parsed === null) return false;
  return parsed.alt && (parsed.mod || parsed.ctrl);
}

/** Menu-backed bindings must carry a real shortcut modifier (mod/ctrl/alt —
 *  Shift alone is a text modifier): a menu accelerator intercepts the combo
 *  app-wide, so a bare Enter/Escape or Shift+Enter there would eat normal
 *  typing everywhere. AltGr-shaped chords are rejected too (see
 *  isAltGrShapedBinding). */
export function isValidMenuBinding(binding: string): boolean {
  const parsed = parseBinding(binding);
  if (parsed === null) return false;
  if (!(parsed.mod || parsed.ctrl || parsed.alt)) return false;
  if (isAltGrShapedBinding(binding)) return false;
  return true;
}

// Single printable chars Electron accepts as accelerator key codes — mirrors
// ACCELERATOR_PUNCT in main/menu.ts (letters/digits pass via the regex; every
// canonical named key already has an accelerator form there). Notably absent:
// the single quote, which keymap binds fine (Quote → `'`) but Electron cannot
// register.
const ACCELERATOR_EXPRESSIBLE_PUNCT = new Set([',', '.', '/', '\\', ';', '[', ']', '-', '=', '`']);

/** True when the binding can be expressed as an Electron accelerator
 *  (menu.ts bindingToAccelerator). Bindings registered NATIVELY with no
 *  renderer fallback — OS_GLOBAL_ACTIONS — must be rejected at record time
 *  when this is false, or the settings row would show a shortcut that can
 *  never fire. */
export function isAcceleratorExpressible(binding: string): boolean {
  const parsed = parseBinding(binding);
  if (parsed === null) return false;
  if (parsed.key.length !== 1) return true;
  return /^[a-z0-9]$/.test(parsed.key) || ACCELERATOR_EXPRESSIBLE_PUNCT.has(parsed.key);
}

/** Bindings already owned by the native menu (main/menu.ts role items —
 *  edit/view/window/app menus) or the OS. A native menu accelerator
 *  intercepts the key before the renderer ever sees it, so assigning one of
 *  these records fine but never fires — or worse, does something unexpected:
 *  'mod+r' reloads the app, 'mod+w' closes the window.
 *
 *  Split by platform: several role accelerators are mac-only (fullscreen,
 *  minimize, quit, hide, the ⌥⌘I devtools form), and on non-Apple platforms
 *  `bindingsEquivalent` merges ctrl/mod — a mac-only chord like 'ctrl+mod+f'
 *  would otherwise collapse into plain 'ctrl+f' and reserve it by mistake. */
const RESERVED_COMMON: readonly string[] = [
  // editMenu role
  'mod+z',
  'shift+mod+z',
  'mod+x',
  'mod+c',
  'mod+v',
  'mod+a',
  // View roles: reload / force reload / zoom (Zoom In's real chord is the
  // SHIFTED plus on common layouts — recording prefers e.code, so it stores
  // as 'shift+mod+='; the NumpadAdd form stores as 'plus')
  'mod+r',
  'shift+mod+r',
  'mod+0',
  'mod+-',
  'mod+=',
  'shift+mod+=',
  'mod+plus',
  'shift+mod+plus',
  // Close window (File menu role, CmdOrCtrl+W)
  'mod+w',
];

const RESERVED_NON_APPLE: readonly string[] = [
  ...RESERVED_COMMON,
  // Non-mac: devtools (Ctrl+Shift+I), fullscreen (F11), OS-level close
  // window (Alt+F4), paste-and-match-style (⇧⌃V), and redo (Ctrl+Y).
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
    // macOS-only: minimize, devtools, fullscreen, quit, hide,
    // paste-and-match-style
    // (⌘⌥⇧V on mac per the Electron role table)
    'mod+m',
    'alt+mod+i',
    'ctrl+mod+f',
    'mod+q',
    'mod+h',
    'alt+shift+mod+v',
  ],
  other: [
    ...RESERVED_NON_APPLE,
    // Linux keeps Electron's Window menu and its minimize role.
    'mod+m',
  ],
  windows: [
    ...RESERVED_NON_APPLE,
    // The custom Windows menu omits Window/minimize, leaving Ctrl+M free.
    'alt+f',
    'alt+e',
    'alt+v',
    'alt+h',
  ],
};

/** True when the binding collides with a native menu/OS accelerator on the
 *  current platform (platform-aware comparison). */
export function isReservedBinding(binding: string): boolean {
  const windows =
    typeof navigator !== 'undefined' &&
    (navigator.platform.startsWith('Win') ||
      (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ===
        'Windows');
  const list = isAppleShortcutPlatform()
    ? RESERVED_NATIVE_BINDINGS.apple
    : windows
      ? RESERVED_NATIVE_BINDINGS.windows
      : RESERVED_NATIVE_BINDINGS.other;
  return list.some((reserved) =>
    bindingsEquivalent(reserved, binding),
  );
}

/** Combos owned by hardcoded app behavior (NOT in the registry, so conflict
 *  detection can't see them): the Composer consumes Ctrl/Cmd+S as steer
 *  before any customizable key, in every context it has focus. Assigning one
 *  of these records fine but never fires from inside the composer. */
export const HARDCODED_BINDINGS: readonly string[] = ['ctrl+s', 'mod+s'];

/** True when the binding collides with a hardcoded app chord
 *  (platform-aware comparison). */
export function isHardcodedBinding(binding: string): boolean {
  return HARDCODED_BINDINGS.some((hardcoded) => bindingsEquivalent(hardcoded, binding));
}

/** Same dead-binding problem as steer: ConversationPane's document-level
 *  handler consumes Cmd/Ctrl+F (transcript find bar) before App.vue's
 *  dispatcher — preventDefault'd there, the dispatcher returns early, so a
 *  custom binding on the chord would record fine and never fire. */
export const HARDCODED_FIND_BINDINGS: readonly string[] = ['mod+f'];

/** True when the binding collides with the hardcoded transcript-find chord
 *  (platform-aware comparison). */
export function isHardcodedFindBinding(binding: string): boolean {
  return HARDCODED_FIND_BINDINGS.some((hardcoded) => bindingsEquivalent(hardcoded, binding));
}

/** Platform-aware binding equivalence. On non-Apple platforms `mod` and
 *  `ctrl` collapse into the same physical flag (both mean Ctrl), so 'mod+s'
 *  and 'ctrl+s' are the same combo there and must conflict; on Apple they
 *  stay distinct (⌘ vs ⌃). */
export function bindingsEquivalent(a: string, b: string): boolean {
  const pa = parseBinding(a);
  const pb = parseBinding(b);
  if (pa === null || pb === null) return a === b;
  if (pa.key !== pb.key || pa.alt !== pb.alt || pa.shift !== pb.shift) return false;
  if (isAppleShortcutPlatform()) {
    return pa.mod === pb.mod && pa.ctrl === pb.ctrl;
  }
  return (pa.mod || pa.ctrl) === (pb.mod || pb.ctrl);
}

/** First other action already bound to `binding`; null when free. `overrides`
 *  maps action id → binding (null = unassigned; absent = default), mirroring
 *  the persistence shape in useShortcuts. Comparison is platform-aware
 *  (bindingsEquivalent) and native-wide actions (menu accelerators, OS
 *  global shortcuts) conflict across scopes. */
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
    const override = overrides[action.id];
    // The extra aliases stay owned whenever the EFFECTIVE binding equals the
    // default — whether the user left it alone or explicitly re-recorded the
    // same value (Composer enables the aliases by value, so conflict
    // detection must match). A different override releases them.
    const effective = override !== undefined ? override : action.defaultBinding;
    const owned =
      effective === action.defaultBinding ? [effective, ...(action.extraBindings ?? [])] : [effective];
    for (const candidate of owned) {
      if (candidate !== null && bindingsEquivalent(candidate, binding)) return action.id;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

const KEY_DISPLAY: Record<string, string> = {
  enter: '↵',
  escape: 'Esc',
  tab: '⇥',
  space: 'Space',
  plus: '+',
  backspace: '⌫',
  delete: 'Del',
  insert: 'Ins',
  home: 'Home',
  end: 'End',
  pageup: 'PgUp',
  pagedown: 'PgDn',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
};

/** Keycap labels for <Kbd :keys="…">: ['⇧','⌘','A'] on Apple platforms,
 *  ['Shift','Ctrl','A'] elsewhere (canonical order = display order). */
export function formatBindingKeys(binding: string): string[] {
  const parsed = parseBinding(binding);
  if (parsed === null) return [];
  const isApple = isAppleShortcutPlatform();
  const keys: string[] = [];
  if (parsed.ctrl) keys.push(isApple ? '⌃' : 'Ctrl');
  if (parsed.alt) keys.push(isApple ? '⌥' : 'Alt');
  if (parsed.shift) keys.push(isApple ? '⇧' : 'Shift');
  if (parsed.mod) keys.push(isApple ? '⌘' : 'Ctrl');
  const key = KEY_DISPLAY[parsed.key];
  keys.push(key ?? (parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key));
  return keys;
}

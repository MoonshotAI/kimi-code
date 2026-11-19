import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bindingFromEvent,
  bindingsEquivalent,
  effectiveBinding,
  findConflict,
  isAcceleratorExpressible,
  isAltGrShapedBinding,
  isBrowserReservedBinding,
  isHardcodedBinding,
  isHardcodedFindBinding,
  isReservedBinding,
  isValidBinding,
  isValidMenuBinding,
  matchBinding,
  MENU_SYNCED_ACTIONS,
  normalizeEventKey,
  OS_GLOBAL_ACTIONS,
  parseBinding,
  RESERVED_BROWSER_BINDINGS,
  RESERVED_NATIVE_BINDINGS,
  serializeBinding,
  SHORTCUT_ACTIONS,
  shortcutActionById,
} from '../../src/renderer/lib/keymap';

function keyEvent(init: {
  key: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  altGraph?: boolean;
}): KeyboardEvent {
  return {
    key: init.key,
    code: init.code ?? '',
    metaKey: init.metaKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    altKey: init.altKey ?? false,
    shiftKey: init.shiftKey ?? false,
    getModifierState: (name: string) => name === 'AltGraph' && (init.altGraph ?? false),
  } as KeyboardEvent;
}

function stubPlatform(platform: string): void {
  vi.stubGlobal('navigator', { platform });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isHardcodedFindBinding', () => {
  it('reserves mod+f on Apple and leaves ctrl+f free', () => {
    stubPlatform('MacIntel');
    expect(isHardcodedFindBinding('mod+f')).toBe(true);
    expect(isHardcodedFindBinding('ctrl+f')).toBe(false);
    expect(isHardcodedFindBinding('shift+mod+f')).toBe(false);
  });

  it('collapses mod/ctrl off Apple — both spellings reserved', () => {
    stubPlatform('Win32');
    expect(isHardcodedFindBinding('mod+f')).toBe(true);
    expect(isHardcodedFindBinding('ctrl+f')).toBe(true);
  });
});

describe('normalizeEventKey', () => {
  it('lowercases printable chars and rejects pure modifiers', () => {
    expect(normalizeEventKey('A')).toBe('a');
    expect(normalizeEventKey(',')).toBe(',');
    expect(normalizeEventKey('Meta')).toBeNull();
    expect(normalizeEventKey('Control')).toBeNull();
    expect(normalizeEventKey('Shift')).toBeNull();
    expect(normalizeEventKey('Alt')).toBeNull();
  });

  it('maps named keys and rejects unknown ones', () => {
    expect(normalizeEventKey('Enter')).toBe('enter');
    expect(normalizeEventKey('Escape')).toBe('escape');
    expect(normalizeEventKey('ArrowUp')).toBe('arrowup');
    expect(normalizeEventKey(' ')).toBe('space');
    expect(normalizeEventKey('+')).toBe('plus');
    expect(normalizeEventKey('F5')).toBe('f5');
    expect(normalizeEventKey('F13')).toBeNull();
    expect(normalizeEventKey('Dead')).toBeNull();
  });
});

describe('parseBinding / serializeBinding', () => {
  it('round-trips canonical bindings', () => {
    expect(serializeBinding(parseBinding('shift+mod+a')!)).toBe('shift+mod+a');
    expect(serializeBinding(parseBinding('alt+mod+s')!)).toBe('alt+mod+s');
    expect(serializeBinding(parseBinding('enter')!)).toBe('enter');
    expect(serializeBinding(parseBinding('mod+,')!)).toBe('mod+,');
    expect(serializeBinding(parseBinding('ctrl+plus')!)).toBe('ctrl+plus');
  });

  it('reorders modifiers into canonical order', () => {
    expect(serializeBinding(parseBinding('mod+shift+a')!)).toBe('shift+mod+a');
  });

  it('rejects malformed bindings', () => {
    expect(parseBinding('')).toBeNull();
    expect(parseBinding('mod')).toBeNull();
    expect(parseBinding('mod+mod+a')).toBeNull();
    expect(parseBinding('a+b')).toBeNull();
    expect(parseBinding('mod+unknownkey')).toBeNull();
  });
});

describe('matchBinding (Apple platform)', () => {
  it('matches mod as metaKey with exact modifiers', () => {
    stubPlatform('MacIntel');
    expect(matchBinding(keyEvent({ key: 'k', metaKey: true }), 'mod+k')).toBe(true);
    expect(matchBinding(keyEvent({ key: 'k', metaKey: true, shiftKey: true }), 'mod+k')).toBe(false);
    expect(matchBinding(keyEvent({ key: 'k', ctrlKey: true }), 'mod+k')).toBe(false);
    expect(matchBinding(keyEvent({ key: 'k', ctrlKey: true }), 'ctrl+k')).toBe(true);
  });

  it('matches shift+key combos by lowered key', () => {
    stubPlatform('MacIntel');
    expect(matchBinding(keyEvent({ key: 'A', metaKey: true, shiftKey: true }), 'mod+shift+a')).toBe(true);
    expect(matchBinding(keyEvent({ key: 's', altKey: true, metaKey: true }), 'alt+mod+s')).toBe(true);
    expect(matchBinding(keyEvent({ key: ',', metaKey: true }), 'mod+,')).toBe(true);
  });

  it('matches bare special keys', () => {
    stubPlatform('MacIntel');
    expect(matchBinding(keyEvent({ key: 'Enter' }), 'enter')).toBe(true);
    expect(matchBinding(keyEvent({ key: 'Enter', shiftKey: true }), 'shift+enter')).toBe(true);
    expect(matchBinding(keyEvent({ key: 'Escape' }), 'escape')).toBe(true);
  });

  it('matches Option combos by physical code, not the Option-modified character', () => {
    stubPlatform('MacIntel');
    expect(matchBinding(keyEvent({ key: 'å', code: 'KeyA', altKey: true, metaKey: true }), 'alt+mod+a')).toBe(true);
    expect(matchBinding(keyEvent({ key: '∫', code: 'KeyB', altKey: true, metaKey: true }), 'alt+mod+b')).toBe(true);
    expect(matchBinding(keyEvent({ key: 'ø', code: 'KeyO', altKey: true, metaKey: true }), 'alt+mod+o')).toBe(true);
    expect(matchBinding(keyEvent({ key: 'å', code: 'KeyA', altKey: true, metaKey: true }), 'alt+mod+b')).toBe(false);
  });

  it('never matches AltGraph (text input on Windows/Linux layouts)', () => {
    stubPlatform('Win32');
    const typing = keyEvent({ key: 'ą', code: 'KeyA', ctrlKey: true, altKey: true, altGraph: true });
    expect(matchBinding(typing, 'alt+mod+a')).toBe(false);
    expect(matchBinding(keyEvent({ key: 'a', code: 'KeyA', ctrlKey: true, altKey: true }), 'alt+mod+a')).toBe(true);
  });

  it('never matches transformed Option chars for alt-only bindings (macOS typing)', () => {
    stubPlatform('MacIntel');
    expect(matchBinding(keyEvent({ key: 'å', code: 'KeyA', altKey: true }), 'alt+a')).toBe(false);
    expect(matchBinding(keyEvent({ key: 'ø', code: 'KeyO', altKey: true }), 'alt+o')).toBe(false);
    expect(matchBinding(keyEvent({ key: 'å', code: 'KeyA', altKey: true, metaKey: true }), 'alt+mod+a')).toBe(true);
    expect(matchBinding(keyEvent({ key: 'a', code: 'KeyA', altKey: true }), 'alt+a')).toBe(true);
  });

  it('matches the plus key via its alias', () => {
    stubPlatform('Win32');
    expect(matchBinding(keyEvent({ key: '+', code: 'NumpadAdd', ctrlKey: true }), 'ctrl+plus')).toBe(true);
  });

  it('rejects malformed bindings', () => {
    stubPlatform('MacIntel');
    expect(matchBinding(keyEvent({ key: 'k', metaKey: true }), 'mod')).toBe(false);
  });
});

describe('matchBinding (non-Apple platform)', () => {
  it('matches mod as ctrlKey and ignores metaKey', () => {
    stubPlatform('Win32');
    expect(matchBinding(keyEvent({ key: 'k', ctrlKey: true }), 'mod+k')).toBe(true);
    expect(matchBinding(keyEvent({ key: 'k', metaKey: true }), 'mod+k')).toBe(false);
    expect(matchBinding(keyEvent({ key: 'k', ctrlKey: true, shiftKey: true }), 'mod+shift+k')).toBe(true);
  });
});

describe('bindingFromEvent', () => {
  it('captures the platform-resolved combo', () => {
    stubPlatform('MacIntel');
    expect(bindingFromEvent(keyEvent({ key: 'A', metaKey: true, shiftKey: true }))).toBe('shift+mod+a');
    expect(bindingFromEvent(keyEvent({ key: 's', metaKey: true, ctrlKey: false, altKey: true }))).toBe('alt+mod+s');
    expect(bindingFromEvent(keyEvent({ key: 'Enter' }))).toBe('enter');
    expect(bindingFromEvent(keyEvent({ key: 'Enter', shiftKey: true }))).toBe('shift+enter');
    expect(bindingFromEvent(keyEvent({ key: 's', ctrlKey: true }))).toBe('ctrl+s');
    expect(bindingFromEvent(keyEvent({ key: 'å', code: 'KeyA', altKey: true, metaKey: true }))).toBe('alt+mod+a');
    expect(bindingFromEvent(keyEvent({ key: '+', code: 'NumpadAdd', ctrlKey: true }))).toBe('ctrl+plus');
  });

  it('returns null for pure modifier presses', () => {
    stubPlatform('MacIntel');
    expect(bindingFromEvent(keyEvent({ key: 'Meta', metaKey: true }))).toBeNull();
    expect(bindingFromEvent(keyEvent({ key: 'Shift', shiftKey: true }))).toBeNull();
  });

  it('captures mod from ctrlKey on non-Apple platforms', () => {
    stubPlatform('Win32');
    expect(bindingFromEvent(keyEvent({ key: 'k', ctrlKey: true }))).toBe('mod+k');
  });
});

describe('isValidBinding', () => {
  it('rejects bare printable keys in every scope', () => {
    expect(isValidBinding('a', 'global')).toBe(false);
    expect(isValidBinding('a', 'composer')).toBe(false);
    expect(isValidBinding('a', 'conversation')).toBe(false);
    expect(isValidBinding(',', 'global')).toBe(false);
  });

  it('accepts modified printable keys and bare special keys', () => {
    expect(isValidBinding('mod+a', 'global')).toBe(true);
    expect(isValidBinding('shift+enter', 'composer')).toBe(true);
    expect(isValidBinding('enter', 'composer')).toBe(true);
    expect(isValidBinding('escape', 'conversation')).toBe(true);
    expect(isValidBinding('f5', 'global')).toBe(true);
  });

  it('narrows composer bare keys to Enter (textarea typing must survive)', () => {
    expect(isValidBinding('enter', 'composer')).toBe(true);
    expect(isValidBinding('shift+enter', 'composer')).toBe(true);
    expect(isValidBinding('space', 'composer')).toBe(false);
    expect(isValidBinding('backspace', 'composer')).toBe(false);
    expect(isValidBinding('delete', 'composer')).toBe(false);
    expect(isValidBinding('tab', 'composer')).toBe(false);
    expect(isValidBinding('arrowup', 'composer')).toBe(false);
    expect(isValidBinding('escape', 'composer')).toBe(false);
    expect(isValidBinding('mod+enter', 'composer')).toBe(true);
    expect(isValidBinding('mod+escape', 'composer')).toBe(true);
  });

  it('rejects bare text-editing keys in the global scope (typing breakers)', () => {
    expect(isValidBinding('space', 'global')).toBe(false);
    expect(isValidBinding('backspace', 'global')).toBe(false);
    expect(isValidBinding('delete', 'global')).toBe(false);
    expect(isValidBinding('arrowup', 'global')).toBe(false);
    expect(isValidBinding('enter', 'global')).toBe(false);
    expect(isValidBinding('tab', 'global')).toBe(false);
    expect(isValidBinding('escape', 'global')).toBe(false);
    expect(isValidBinding('escape', 'conversation')).toBe(true);
    expect(isValidBinding('f5', 'global')).toBe(true);
    expect(isValidBinding('shift+f5', 'global')).toBe(true);
  });

  it('rejects alt-only printable bindings on Apple platforms in EVERY scope (Option is a text modifier)', () => {
    stubPlatform('MacIntel');
    expect(isValidBinding('alt+a', 'global')).toBe(false);
    expect(isValidBinding('alt+o', 'global')).toBe(false);
    expect(isValidBinding('alt+a', 'composer')).toBe(false);
    expect(isValidBinding('alt+mod+a', 'global')).toBe(true);
    expect(isValidBinding('alt+enter', 'global')).toBe(true);
    stubPlatform('Win32');
    expect(isValidBinding('alt+a', 'global')).toBe(true);
    expect(isValidBinding('alt+a', 'composer')).toBe(true);
  });

  it('rejects Shift-only printable chords (they would eat uppercase typing)', () => {
    expect(isValidBinding('shift+a', 'global')).toBe(false);
    expect(isValidBinding('shift+a', 'composer')).toBe(false);
    expect(isValidBinding('shift+1', 'global')).toBe(false);
    expect(isValidBinding('shift+mod+a', 'global')).toBe(true);
    expect(isValidBinding('shift+f5', 'global')).toBe(true);
    expect(isValidBinding('shift+enter', 'composer')).toBe(true);
  });

  it('rejects malformed bindings', () => {
    expect(isValidBinding('mod', 'global')).toBe(false);
    expect(isValidBinding('mod+unknownkey', 'global')).toBe(false);
  });
});

describe('findConflict', () => {
  it('finds same-scope duplicates against defaults and overrides', () => {
    expect(findConflict({}, 'global', 'mod+n', 'searchSessions')).toBe('newSession');
    expect(findConflict({}, 'global', 'mod+n', 'newSession')).toBeNull();
    expect(findConflict({ newSession: null }, 'global', 'mod+n', 'searchSessions')).toBeNull();
    expect(findConflict({ searchSessions: 'mod+b' }, 'global', 'mod+b', 'toggleSidebar')).toBe('searchSessions');
  });

  it('conflicts within the composer scope', () => {
    expect(findConflict({}, 'composer', 'shift+enter', 'composer.send')).toBe('composer.newline');
  });

  it('menu-backed actions conflict across scopes (both directions)', () => {
    stubPlatform('MacIntel');
    expect(findConflict({}, 'composer', 'mod+,', 'composer.send')).toBe('openSettings');
    expect(findConflict({}, 'global', 'enter', 'openSettings')).toBe('composer.send');
  });

  it('OS-global actions conflict across scopes like menu-backed ones (both directions)', () => {
    stubPlatform('MacIntel');
    expect(findConflict({}, 'composer', 'shift+mod+space', 'composer.send')).toBe('summonApp');
    expect(findConflict({}, 'global', 'mod+enter', 'summonApp')).toBe('composer.send');
  });

  it('does not cross scopes for non-menu-backed actions', () => {
    stubPlatform('MacIntel');
    expect(findConflict({}, 'composer', 'mod+k', 'composer.send')).toBeNull();
  });

  it('treats mod and ctrl as the same combo on non-Apple platforms', () => {
    stubPlatform('Win32');
    expect(findConflict({ 'composer.send': 'ctrl+enter' }, 'composer', 'mod+enter', 'composer.newline')).toBe('composer.send');
  });

  it('keeps mod and ctrl distinct on Apple platforms', () => {
    stubPlatform('MacIntel');
    expect(findConflict({ 'composer.send': 'ctrl+enter' }, 'composer', 'mod+enter', 'composer.newline')).toBeNull();
  });

  it('covers extraBindings (expanded-editor send aliases)', () => {
    stubPlatform('MacIntel');
    expect(findConflict({}, 'global', 'mod+enter', 'newSession')).toBe('composer.send');
    expect(findConflict({}, 'global', 'ctrl+enter', 'openFolder')).toBe('composer.send');
    expect(findConflict({}, 'composer', 'mod+enter', 'composer.newline')).toBe('composer.send');
    expect(findConflict({ 'composer.send': 'shift+mod+p' }, 'composer', 'mod+enter', 'composer.newline')).toBeNull();
    expect(findConflict({ 'composer.send': 'enter' }, 'composer', 'mod+enter', 'composer.newline')).toBe('composer.send');
  });

  it('an explicit override shadows a colliding default of another action', () => {
    const toggle = shortcutActionById('toggleTerminal')!;
    expect(effectiveBinding(toggle, {})).toBe('ctrl+`');
    expect(effectiveBinding(toggle, { openDiffTab: 'ctrl+`' })).toBeNull();
    expect(effectiveBinding(toggle, { searchSessions: 'ctrl+`' })).toBeNull();
    expect(effectiveBinding(toggle, { toggleTerminal: 'ctrl+shift+j' })).toBe('ctrl+shift+j');
    expect(findConflict({}, 'global', 'ctrl+`', 'openDiffTab')).toBe('toggleTerminal');
    expect(findConflict({ openDiffTab: 'ctrl+`' }, 'global', 'ctrl+`', 'newSession')).toBe('openDiffTab');
    expect(findConflict({ searchSessions: 'ctrl+`' }, 'global', 'ctrl+`', 'openDiffTab')).toBe('searchSessions');
  });

  it('only shadows defaults when the override actually competes for the same event', () => {
    const search = shortcutActionById('searchSessions')!;
    expect(effectiveBinding(search, { 'composer.newline': 'mod+k' })).toBe('mod+k');
    const newline = shortcutActionById('composer.newline')!;
    expect(effectiveBinding(newline, { toggleTerminal: 'shift+enter' })).toBeNull();
  });
});

describe('bindingsEquivalent', () => {
  it('collapses mod/ctrl on non-Apple platforms only', () => {
    stubPlatform('Win32');
    expect(bindingsEquivalent('mod+s', 'ctrl+s')).toBe(true);
    expect(bindingsEquivalent('mod+s', 's')).toBe(false);

    stubPlatform('MacIntel');
    expect(bindingsEquivalent('mod+s', 'ctrl+s')).toBe(false);
    expect(bindingsEquivalent('mod+s', 'mod+s')).toBe(true);
  });

  it('still compares key and other modifiers', () => {
    stubPlatform('Win32');
    expect(bindingsEquivalent('mod+a', 'mod+b')).toBe(false);
    expect(bindingsEquivalent('shift+mod+s', 'mod+s')).toBe(false);
    expect(bindingsEquivalent('alt+mod+s', 'shift+mod+s')).toBe(false);
  });
});

describe('isValidMenuBinding', () => {
  it('requires a real shortcut modifier (mod/ctrl/alt, not Shift alone)', () => {
    stubPlatform('MacIntel');
    expect(isValidMenuBinding('mod+,')).toBe(true);
    expect(isValidMenuBinding('alt+mod+o')).toBe(true);
    expect(isValidMenuBinding('shift+mod+p')).toBe(true);
    expect(isValidMenuBinding('enter')).toBe(false);
    expect(isValidMenuBinding('escape')).toBe(false);
    expect(isValidMenuBinding('f5')).toBe(false);
    expect(isValidMenuBinding('shift+enter')).toBe(false);
    expect(isValidMenuBinding('shift+a')).toBe(false);
    expect(isValidMenuBinding('mod')).toBe(false);
  });

  it('rejects AltGr-shaped chords on non-Apple platforms', () => {
    stubPlatform('Win32');
    expect(isValidMenuBinding('alt+mod+o')).toBe(false);
    expect(isValidMenuBinding('alt+ctrl+o')).toBe(false);
    expect(isValidMenuBinding('alt+o')).toBe(true);
    expect(isValidMenuBinding('mod+o')).toBe(true);
  });
});

describe('isAcceleratorExpressible', () => {
  it('accepts letters, digits, named keys, and Electron punctuation', () => {
    expect(isAcceleratorExpressible('mod+a')).toBe(true);
    expect(isAcceleratorExpressible('mod+1')).toBe(true);
    expect(isAcceleratorExpressible('shift+mod+space')).toBe(true);
    expect(isAcceleratorExpressible('mod+enter')).toBe(true);
    expect(isAcceleratorExpressible('f5')).toBe(true);
    expect(isAcceleratorExpressible('mod+,')).toBe(true);
    expect(isAcceleratorExpressible('mod+plus')).toBe(true);
    expect(isAcceleratorExpressible('shift+mod+=')).toBe(true);
  });

  it('rejects the single quote (bindable via Quote, but not an accelerator key code)', () => {
    expect(isAcceleratorExpressible("mod+'")).toBe(false);
    expect(isAcceleratorExpressible("'")).toBe(false);
  });

  it('rejects malformed bindings', () => {
    expect(isAcceleratorExpressible('mod')).toBe(false);
    expect(isAcceleratorExpressible('mod+unknownkey')).toBe(false);
  });
});

describe('isAltGrShapedBinding', () => {
  it('flags alt+(mod|ctrl) chords on non-Apple platforms only', () => {
    stubPlatform('Win32');
    expect(isAltGrShapedBinding('alt+mod+e')).toBe(true);
    expect(isAltGrShapedBinding('alt+ctrl+e')).toBe(true);
    expect(isAltGrShapedBinding('alt+shift+mod+e')).toBe(true);
    expect(isAltGrShapedBinding('alt+e')).toBe(false);
    expect(isAltGrShapedBinding('alt+f5')).toBe(false);
    expect(isAltGrShapedBinding('mod+e')).toBe(false);
    stubPlatform('MacIntel');
    expect(isAltGrShapedBinding('alt+mod+e')).toBe(false);
    expect(isAltGrShapedBinding('alt+ctrl+e')).toBe(false);
  });
});

describe('registry defaults sanity', () => {
  it('every default binding is valid, unreserved, unhardcoded, and conflict-free on both platforms', () => {
    for (const platform of ['MacIntel', 'Win32'] as const) {
      stubPlatform(platform);
      for (const action of SHORTCUT_ACTIONS) {
        const def = action.defaultBinding;
        if (def === null) continue;
        const label = `${action.id} (${def}) on ${platform}`;
        expect(isValidBinding(def, action.scope), label).toBe(true);
        expect(isReservedBinding(def, action.id), `${label} is natively reserved`).toBe(false);
        expect(isHardcodedBinding(def), `${label} is a hardcoded chord`).toBe(false);
        expect(findConflict({}, action.scope, def, action.id), `${label} conflicts`).toBeNull();
        if (MENU_SYNCED_ACTIONS.includes(action.id)) {
          expect(isValidMenuBinding(def), `${label} menu-invalid`).toBe(true);
        }
        if (OS_GLOBAL_ACTIONS.includes(action.id)) {
          expect(isValidMenuBinding(def), `${label} os-global-invalid`).toBe(true);
          expect(isAcceleratorExpressible(def), `${label} accelerator-inexpressible`).toBe(true);
        }
        for (const extra of action.extraBindings ?? []) {
          expect(findConflict({}, action.scope, extra, action.id), `${label} extra ${extra} conflicts`).toBeNull();
        }
      }
    }
  });
});

describe('openDiffTab registration', () => {
  it('defaults to ctrl+shift+g, global and session-scoped, renderer-dispatched', () => {
    const action = shortcutActionById('openDiffTab');
    expect(action).toMatchObject({
      scope: 'global',
      defaultBinding: 'ctrl+shift+g',
      requiresSession: true,
    });
    expect(MENU_SYNCED_ACTIONS).not.toContain('openDiffTab');
    expect(OS_GLOBAL_ACTIONS).not.toContain('openDiffTab');
  });

  it('matches the physical chord on both platforms', () => {
    stubPlatform('MacIntel');
    expect(matchBinding(keyEvent({ key: 'G', code: 'KeyG', ctrlKey: true, shiftKey: true }), 'ctrl+shift+g')).toBe(true);
    expect(matchBinding(keyEvent({ key: 'g', code: 'KeyG', ctrlKey: true }), 'ctrl+shift+g')).toBe(false);
    expect(matchBinding(keyEvent({ key: 'G', code: 'KeyG', metaKey: true, shiftKey: true }), 'ctrl+shift+g')).toBe(false);
    stubPlatform('Win32');
    expect(matchBinding(keyEvent({ key: 'G', code: 'KeyG', ctrlKey: true, shiftKey: true }), 'ctrl+shift+g')).toBe(true);
  });
});

describe('toggleFilesPanel registration', () => {
  it('defaults to shift+mod+e, global and not session-scoped, renderer-dispatched', () => {
    const action = shortcutActionById('toggleFilesPanel');
    expect(action).toMatchObject({
      scope: 'global',
      defaultBinding: 'shift+mod+e',
    });
    expect(action?.requiresSession).toBeUndefined();
    expect(MENU_SYNCED_ACTIONS).not.toContain('toggleFilesPanel');
    expect(OS_GLOBAL_ACTIONS).not.toContain('toggleFilesPanel');
  });

  it('matches the physical chord on both platforms', () => {
    stubPlatform('MacIntel');
    expect(matchBinding(keyEvent({ key: 'E', code: 'KeyE', metaKey: true, shiftKey: true }), 'shift+mod+e')).toBe(true);
    expect(matchBinding(keyEvent({ key: 'e', code: 'KeyE', metaKey: true }), 'shift+mod+e')).toBe(false);
    expect(matchBinding(keyEvent({ key: 'E', code: 'KeyE', ctrlKey: true, shiftKey: true }), 'shift+mod+e')).toBe(false);
    stubPlatform('Win32');
    expect(matchBinding(keyEvent({ key: 'E', code: 'KeyE', ctrlKey: true, shiftKey: true }), 'shift+mod+e')).toBe(true);
  });

  it('moves sidebarTabWorkspaces off shift+mod+e', () => {
    expect(shortcutActionById('sidebarTabWorkspaces')?.defaultBinding).toBe('shift+mod+w');
    expect(findConflict({}, 'global', 'shift+mod+e', 'toggleFilesPanel')).toBeNull();
  });
});

describe('closeSessionView registration (two-step close: session view → draft page → hide window)', () => {
  it('defaults to mod+w, global and menu-synced, not OS-global', () => {
    const action = shortcutActionById('closeSessionView');
    expect(action).toMatchObject({
      scope: 'global',
      defaultBinding: 'mod+w',
    });
    expect(MENU_SYNCED_ACTIONS).toContain('closeSessionView');
    expect(OS_GLOBAL_ACTIONS).not.toContain('closeSessionView');
  });

  it('matches the physical chord on both platforms', () => {
    stubPlatform('MacIntel');
    expect(matchBinding(keyEvent({ key: 'w', code: 'KeyW', metaKey: true }), 'mod+w')).toBe(true);
    expect(matchBinding(keyEvent({ key: 'w', code: 'KeyW', ctrlKey: true }), 'mod+w')).toBe(false);
    stubPlatform('Win32');
    expect(matchBinding(keyEvent({ key: 'w', code: 'KeyW', ctrlKey: true }), 'mod+w')).toBe(true);
  });
});

describe('isHardcodedBinding', () => {
  it('flags the hardcoded steer chord, platform-aware', () => {
    stubPlatform('MacIntel');
    expect(isHardcodedBinding('ctrl+s')).toBe(true);
    expect(isHardcodedBinding('mod+s')).toBe(true);
    expect(isHardcodedBinding('shift+mod+s')).toBe(false);

    stubPlatform('Win32');
    expect(isHardcodedBinding('mod+s')).toBe(true);
    expect(isHardcodedBinding('ctrl+s')).toBe(true);
  });
});

describe('isReservedBinding', () => {
  it('flags native menu accelerators on Apple platforms', () => {
    stubPlatform('MacIntel');
    expect(isReservedBinding('mod+r')).toBe(true);
    expect(isReservedBinding('mod+w')).toBe(true);
    expect(isReservedBinding('mod+w', 'closeSessionView')).toBe(false);
    expect(isReservedBinding('mod+w', 'summonApp')).toBe(true);
    expect(isReservedBinding('mod+q')).toBe(true);
    expect(isReservedBinding('alt+mod+i')).toBe(true);
    expect(isReservedBinding('ctrl+mod+f')).toBe(true);
    expect(isReservedBinding('mod+m')).toBe(true);
    expect(isReservedBinding('mod+h')).toBe(true);
    expect(isReservedBinding('alt+mod+h')).toBe(true);
    expect(isReservedBinding('alt+shift+mod+v')).toBe(true);
    expect(isReservedBinding('shift+mod+v')).toBe(false);
    expect(isReservedBinding('shift+mod+=')).toBe(true);
    expect(isReservedBinding('mod+plus')).toBe(true);
    expect(isReservedBinding('shift+mod+plus')).toBe(true);
    expect(isReservedBinding('shift+ctrl+i')).toBe(false);
    expect(isReservedBinding('alt+f4')).toBe(false);
    expect(isReservedBinding('mod+,')).toBe(false);
    expect(isReservedBinding('alt+mod+a')).toBe(false);
    expect(isReservedBinding('shift+enter')).toBe(false);
  });

  it('splits mac-only chords out on non-Apple platforms', () => {
    stubPlatform('Win32');
    expect(isReservedBinding('mod+r')).toBe(true);
    expect(isReservedBinding('mod+m')).toBe(false);
    expect(isReservedBinding('shift+ctrl+i')).toBe(true);
    expect(isReservedBinding('f11')).toBe(true);
    expect(isReservedBinding('alt+f4')).toBe(true);
    expect(isReservedBinding('mod+plus')).toBe(true);
    expect(isReservedBinding('shift+mod+v')).toBe(true);
    expect(isReservedBinding('mod+y')).toBe(true);
    expect(isReservedBinding('alt+f')).toBe(true);
    expect(isReservedBinding('alt+e')).toBe(true);
    expect(isReservedBinding('alt+v')).toBe(true);
    expect(isReservedBinding('alt+h')).toBe(true);
    expect(isReservedBinding('ctrl+f')).toBe(false);
    expect(isReservedBinding('mod+f')).toBe(false);
    expect(isReservedBinding('alt+ctrl+i')).toBe(false);
    expect(isReservedBinding('mod+h')).toBe(false);
    expect(isReservedBinding('alt+mod+h')).toBe(false);
    expect(isReservedBinding('alt+shift+mod+v')).toBe(false);

    stubPlatform('Linux x86_64');
    expect(isReservedBinding('alt+f')).toBe(false);
    expect(isReservedBinding('mod+m')).toBe(true);
  });

  it('keeps every reserved entry parseable', () => {
    for (const reserved of [
      ...RESERVED_NATIVE_BINDINGS.apple,
      ...RESERVED_NATIVE_BINDINGS.other,
      ...RESERVED_NATIVE_BINDINGS.windows,
    ]) {
      expect(parseBinding(reserved), reserved).not.toBeNull();
    }
  });
});

describe('isBrowserReservedBinding', () => {
  it('flags browser-owned built-in chords on Apple platforms', () => {
    stubPlatform('MacIntel');
    expect(isBrowserReservedBinding('mod+n')).toBe(true);
    expect(isBrowserReservedBinding('mod+w')).toBe(true);
    expect(isBrowserReservedBinding('shift+mod+w')).toBe(true);
    expect(isBrowserReservedBinding('mod+o')).toBe(true);
    expect(isBrowserReservedBinding('shift+mod+b')).toBe(false);
    expect(isBrowserReservedBinding('shift+mod+d')).toBe(true);
    expect(isBrowserReservedBinding('shift+mod+[')).toBe(true);
    expect(isBrowserReservedBinding('shift+mod+]')).toBe(true);
    expect(isBrowserReservedBinding('ctrl+tab')).toBe(true);
    expect(isBrowserReservedBinding('ctrl+shift+tab')).toBe(true);
    expect(isBrowserReservedBinding('alt+mod+b')).toBe(true);
    expect(isBrowserReservedBinding('mod+,')).toBe(true);
    expect(isBrowserReservedBinding('mod+k')).toBe(false);
    expect(isBrowserReservedBinding('shift+mod+o')).toBe(false);
    expect(isBrowserReservedBinding('mod+t')).toBe(false);
    expect(isBrowserReservedBinding('mod+q')).toBe(false);
    expect(isBrowserReservedBinding('mod+b')).toBe(false);
  });

  it('flags browser-owned built-in chords on other platforms', () => {
    stubPlatform('Win32');
    expect(isBrowserReservedBinding('mod+n')).toBe(true);
    expect(isBrowserReservedBinding('mod+w')).toBe(true);
    expect(isBrowserReservedBinding('mod+o')).toBe(true);
    expect(isBrowserReservedBinding('shift+mod+b')).toBe(true);
    expect(isBrowserReservedBinding('shift+mod+d')).toBe(true);
    expect(isBrowserReservedBinding('shift+mod+[')).toBe(true);
    expect(isBrowserReservedBinding('shift+mod+]')).toBe(true);
    expect(isBrowserReservedBinding('ctrl+tab')).toBe(true);
    expect(isBrowserReservedBinding('mod+k')).toBe(true);
    expect(isBrowserReservedBinding('shift+mod+o')).toBe(true);
    expect(isBrowserReservedBinding('mod+,')).toBe(false);
    expect(isBrowserReservedBinding('alt+mod+b')).toBe(false);
    expect(isBrowserReservedBinding('mod+e')).toBe(false);
    expect(isBrowserReservedBinding('mod+t')).toBe(false);
    expect(isBrowserReservedBinding('mod+b')).toBe(false);
  });

  it('covers exactly the built-in default bindings that browsers reserve', () => {
    const expected: Record<'apple' | 'other', readonly string[]> = {
      apple: [
        'newSession',
        'closeSessionView',
        'openFolder',
        'openSettings',
        'toggleSideChat',
        'sidebarTabDone',
        'sidebarTabWorkspaces',
        'nextPanelTab',
        'previousPanelTab',
        'selectPrevSibling',
        'selectNextSibling',
      ],
      other: [
        'newSession',
        'closeSessionView',
        'searchSessions',
        'openFolder',
        'toggleRightPanel',
        'sidebarTabOpen',
        'sidebarTabDone',
        'sidebarTabWorkspaces',
        'nextPanelTab',
        'previousPanelTab',
        'selectPrevSibling',
        'selectNextSibling',
      ],
    };
    for (const [platform, list] of [
      ['MacIntel', 'apple'],
      ['Win32', 'other'],
    ] as const) {
      stubPlatform(platform);
      const reserved = SHORTCUT_ACTIONS.filter(
        (action) => action.defaultBinding !== null && isBrowserReservedBinding(action.defaultBinding),
      ).map((action) => action.id);
      expect(reserved.sort(), platform).toEqual([...expected[list]].sort());
    }
  });

  it('keeps every reserved entry parseable', () => {
    for (const reserved of [
      ...RESERVED_BROWSER_BINDINGS.apple,
      ...RESERVED_BROWSER_BINDINGS.other,
    ]) {
      expect(parseBinding(reserved), reserved).not.toBeNull();
    }
  });
});

it('binds ctrl+` to the bottom terminal toggle and offers no new-terminal-tab shortcut action', () => {
  const binding = shortcutActionById('toggleTerminal')!.defaultBinding!;
  expect(binding).toBe('ctrl+`');
  expect(MENU_SYNCED_ACTIONS).toContain('toggleTerminal');
  expect(matchBinding(keyEvent({ key: '`', code: 'Backquote', ctrlKey: true }), binding)).toBe(true);
  expect(matchBinding(keyEvent({ key: "'", code: 'Quote', ctrlKey: true }), binding)).toBe(false);
  expect(shortcutActionById('newTerminalTab')).toBeUndefined();
});

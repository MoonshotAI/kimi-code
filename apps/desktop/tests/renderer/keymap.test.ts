import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bindingFromEvent,
  bindingsEquivalent,
  findConflict,
  formatBindingKeys,
  isAcceleratorExpressible,
  isAltGrShapedBinding,
  isAppleShortcutPlatform,
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
  RESERVED_NATIVE_BINDINGS,
  serializeBinding,
  SHORTCUT_ACTIONS,
} from '../../src/renderer/lib/keymap';

// Minimal KeyboardEvent stand-in for the node test environment.
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

describe('isAppleShortcutPlatform', () => {
  it('detects macOS and rejects other platforms', () => {
    stubPlatform('MacIntel');
    expect(isAppleShortcutPlatform()).toBe(true);
    stubPlatform('Win32');
    expect(isAppleShortcutPlatform()).toBe(false);
  });
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
    // The plus key survives the '+'-separated format as the 'plus' alias.
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
    // Extra held modifier → no match (mirrors the old hardcoded steer guard).
    expect(matchBinding(keyEvent({ key: 'k', metaKey: true, shiftKey: true }), 'mod+k')).toBe(false);
    // ctrl is not mod on macOS.
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
    // macOS turns ⌥A into 'å' / ⌥B into '∫' / ⌥O into 'ø' in e.key; the
    // binding must still match via e.code.
    expect(matchBinding(keyEvent({ key: 'å', code: 'KeyA', altKey: true, metaKey: true }), 'alt+mod+a')).toBe(true);
    expect(matchBinding(keyEvent({ key: '∫', code: 'KeyB', altKey: true, metaKey: true }), 'alt+mod+b')).toBe(true);
    expect(matchBinding(keyEvent({ key: 'ø', code: 'KeyO', altKey: true, metaKey: true }), 'alt+mod+o')).toBe(true);
    // …but a different physical key still doesn't match.
    expect(matchBinding(keyEvent({ key: 'å', code: 'KeyA', altKey: true, metaKey: true }), 'alt+mod+b')).toBe(false);
  });

  it('never matches AltGraph (text input on Windows/Linux layouts)', () => {
    stubPlatform('Win32');
    // Polish 'ą' = AltGr+A: reported as ctrl+alt with AltGraph set — it must
    // NOT match 'alt+mod+a' (Ctrl+Alt+A), or typing archives the chat.
    const typing = keyEvent({ key: 'ą', code: 'KeyA', ctrlKey: true, altKey: true, altGraph: true });
    expect(matchBinding(typing, 'alt+mod+a')).toBe(false);
    // A real Ctrl+Alt chord (no AltGraph state) still matches.
    expect(matchBinding(keyEvent({ key: 'a', code: 'KeyA', ctrlKey: true, altKey: true }), 'alt+mod+a')).toBe(true);
  });

  it('never matches transformed Option chars for alt-only bindings (macOS typing)', () => {
    stubPlatform('MacIntel');
    // Typing 'å' = ⌥A (no ⌘/⌃ held): the Option-transformed e.key marks text
    // input, so an alt-only global binding must not fire mid-sentence.
    expect(matchBinding(keyEvent({ key: 'å', code: 'KeyA', altKey: true }), 'alt+a')).toBe(false);
    expect(matchBinding(keyEvent({ key: 'ø', code: 'KeyO', altKey: true }), 'alt+o')).toBe(false);
    // …but a deliberate chord with ⌘ alongside is a shortcut, not typing.
    expect(matchBinding(keyEvent({ key: 'å', code: 'KeyA', altKey: true, metaKey: true }), 'alt+mod+a')).toBe(true);
    // And an untransformed alt-only press (focus outside text fields can still
    // produce the base char on some layouts) matches normally.
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
    // Explicit Ctrl on macOS stays a distinct token.
    expect(bindingFromEvent(keyEvent({ key: 's', ctrlKey: true }))).toBe('ctrl+s');
    // Option-modified characters record their base key (⌥A reports 'å').
    expect(bindingFromEvent(keyEvent({ key: 'å', code: 'KeyA', altKey: true, metaKey: true }))).toBe('alt+mod+a');
    // The plus key records as the 'plus' alias (the format's separator is '+').
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
    // Bare Enter / Shift+Enter are the only composer chords that don't
    // hijack typing or the composer's own hardcoded keys.
    expect(isValidBinding('enter', 'composer')).toBe(true);
    expect(isValidBinding('shift+enter', 'composer')).toBe(true);
    expect(isValidBinding('space', 'composer')).toBe(false);
    expect(isValidBinding('backspace', 'composer')).toBe(false);
    expect(isValidBinding('delete', 'composer')).toBe(false);
    expect(isValidBinding('tab', 'composer')).toBe(false);
    expect(isValidBinding('arrowup', 'composer')).toBe(false);
    // Bare Escape would swallow the composer's menu-closing Esc AND the
    // running-turn interrupt (ConversationPane checks defaultPrevented).
    expect(isValidBinding('escape', 'composer')).toBe(false);
    // …but modified chords stay assignable.
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
    // …but allows them where they belong (conversation), and always allows
    // F-keys globally.
    expect(isValidBinding('escape', 'global')).toBe(false);
    expect(isValidBinding('escape', 'conversation')).toBe(true);
    expect(isValidBinding('f5', 'global')).toBe(true);
    expect(isValidBinding('shift+f5', 'global')).toBe(true);
  });

  it('rejects alt-only printable bindings on Apple platforms in EVERY scope (Option is a text modifier)', () => {
    stubPlatform('MacIntel');
    expect(isValidBinding('alt+a', 'global')).toBe(false);
    expect(isValidBinding('alt+o', 'global')).toBe(false);
    // Composer scope too: matchBinding treats the transformed event as
    // typing everywhere, so the binding would be dead on arrival.
    expect(isValidBinding('alt+a', 'composer')).toBe(false);
    // …but allows them with ⌘/⌃ alongside, and for non-printable keys.
    expect(isValidBinding('alt+mod+a', 'global')).toBe(true);
    expect(isValidBinding('alt+enter', 'global')).toBe(true);
    // Non-Apple platforms keep alt-only bindings (AltGr is guarded at runtime).
    stubPlatform('Win32');
    expect(isValidBinding('alt+a', 'global')).toBe(true);
    expect(isValidBinding('alt+a', 'composer')).toBe(true);
  });

  it('rejects Shift-only printable chords (they would eat uppercase typing)', () => {
    expect(isValidBinding('shift+a', 'global')).toBe(false);
    expect(isValidBinding('shift+a', 'composer')).toBe(false);
    expect(isValidBinding('shift+1', 'global')).toBe(false);
    // …but Shift with a real modifier, or with a special key, is fine.
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
    // 'mod+n' is newSession's default (global scope).
    expect(findConflict({}, 'global', 'mod+n', 'searchSessions')).toBe('newSession');
    // The excluded action may keep its own binding.
    expect(findConflict({}, 'global', 'mod+n', 'newSession')).toBeNull();
    // Overrides win over defaults; unassigned (null) never conflicts.
    expect(findConflict({ newSession: null }, 'global', 'mod+n', 'searchSessions')).toBeNull();
    expect(findConflict({ searchSessions: 'mod+b' }, 'global', 'mod+b', 'toggleSidebar')).toBe('searchSessions');
  });

  it('conflicts within the composer scope', () => {
    // newline defaults to 'shift+enter'.
    expect(findConflict({}, 'composer', 'shift+enter', 'composer.send')).toBe('composer.newline');
  });

  it('menu-backed actions conflict across scopes (both directions)', () => {
    stubPlatform('MacIntel');
    // openSettings (menu-backed) defaults to 'mod+,': assigning it to a
    // composer action conflicts, because the menu accelerator is app-wide.
    expect(findConflict({}, 'composer', 'mod+,', 'composer.send')).toBe('openSettings');
    // …and assigning a menu-backed action to a composer-held combo conflicts
    // too (the excluded action is menu-backed).
    expect(findConflict({}, 'global', 'enter', 'openSettings')).toBe('composer.send');
  });

  it('OS-global actions conflict across scopes like menu-backed ones (both directions)', () => {
    stubPlatform('MacIntel');
    // summonApp defaults to 'shift+mod+space' and is registered with
    // globalShortcut: the OS consumes the chord even while the app is
    // focused, so a composer action bound to it would never fire.
    expect(findConflict({}, 'composer', 'shift+mod+space', 'composer.send')).toBe('summonApp');
    // …and binding summonApp to a composer-owned alias (the expanded send's
    // mod+enter) conflicts the same way — no renderer fallback exists here.
    expect(findConflict({}, 'global', 'mod+enter', 'summonApp')).toBe('composer.send');
  });

  it('does not cross scopes for non-menu-backed actions', () => {
    stubPlatform('MacIntel');
    // searchSessions (global, not menu-backed) holds 'mod+k' — a composer
    // action may reuse it (the composer only sees it while focused).
    expect(findConflict({}, 'composer', 'mod+k', 'composer.send')).toBeNull();
  });

  it('treats mod and ctrl as the same combo on non-Apple platforms', () => {
    stubPlatform('Win32');
    // Recording Ctrl+Enter stores 'mod+enter', which is the SAME physical
    // combo as a 'ctrl+enter' override on Windows — it must conflict, or the
    // new binding would be shadowed forever.
    expect(findConflict({ 'composer.send': 'ctrl+enter' }, 'composer', 'mod+enter', 'composer.newline')).toBe('composer.send');
  });

  it('keeps mod and ctrl distinct on Apple platforms', () => {
    stubPlatform('MacIntel');
    expect(findConflict({ 'composer.send': 'ctrl+enter' }, 'composer', 'mod+enter', 'composer.newline')).toBeNull();
  });

  it('covers extraBindings (expanded-editor send aliases)', () => {
    stubPlatform('MacIntel');
    // While send is at its default, the expanded editor also owns mod+enter /
    // ctrl+enter — a menu-backed action must not claim them (its native
    // accelerator would shadow the expanded send).
    expect(findConflict({}, 'global', 'mod+enter', 'newSession')).toBe('composer.send');
    expect(findConflict({}, 'global', 'ctrl+enter', 'openFolder')).toBe('composer.send');
    // …nor may a sibling composer action.
    expect(findConflict({}, 'composer', 'mod+enter', 'composer.newline')).toBe('composer.send');
    // Once send is rebound, the aliases are released.
    expect(findConflict({ 'composer.send': 'shift+mod+p' }, 'composer', 'mod+enter', 'composer.newline')).toBeNull();
    // …but explicitly re-recording the DEFAULT value keeps them owned
    // (Composer enables the aliases by value).
    expect(findConflict({ 'composer.send': 'enter' }, 'composer', 'mod+enter', 'composer.newline')).toBe('composer.send');
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
    // Ctrl+Alt IS AltGr on many layouts: a native menu accelerator with that
    // shape would fire while the user types AltGr characters.
    expect(isValidMenuBinding('alt+mod+o')).toBe(false);
    expect(isValidMenuBinding('alt+ctrl+o')).toBe(false);
    expect(isValidMenuBinding('alt+o')).toBe(true); // Alt alone is not AltGr
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
    // Alt alone is not AltGr-shaped, and neither are alt-free chords.
    expect(isAltGrShapedBinding('alt+e')).toBe(false);
    expect(isAltGrShapedBinding('alt+f5')).toBe(false);
    expect(isAltGrShapedBinding('mod+e')).toBe(false);
    // Apple platforms have no AltGr — the same chords stay bindable.
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
        expect(isReservedBinding(def), `${label} is natively reserved`).toBe(false);
        expect(isHardcodedBinding(def), `${label} is a hardcoded chord`).toBe(false);
        expect(findConflict({}, action.scope, def, action.id), `${label} conflicts`).toBeNull();
        if (MENU_SYNCED_ACTIONS.includes(action.id)) {
          expect(isValidMenuBinding(def), `${label} menu-invalid`).toBe(true);
        }
        if (OS_GLOBAL_ACTIONS.includes(action.id)) {
          // OS-global bindings have no renderer fallback — the default must be
          // a real Electron accelerator with a real modifier, or the feature
          // ships dead (or steals a bare key system-wide).
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

describe('isHardcodedBinding', () => {
  it('flags the hardcoded steer chord, platform-aware', () => {
    stubPlatform('MacIntel');
    expect(isHardcodedBinding('ctrl+s')).toBe(true);
    expect(isHardcodedBinding('mod+s')).toBe(true);
    expect(isHardcodedBinding('shift+mod+s')).toBe(false);

    // On Windows the two forms are the same physical chord.
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
    expect(isReservedBinding('mod+q')).toBe(true);
    expect(isReservedBinding('alt+mod+i')).toBe(true);
    expect(isReservedBinding('ctrl+mod+f')).toBe(true);
    // The native Window menu owns minimize on macOS.
    expect(isReservedBinding('mod+m')).toBe(true);
    // Paste-and-match-style is ⌘⌥⇧V on macOS (⇧⌘V is the non-mac form).
    expect(isReservedBinding('alt+shift+mod+v')).toBe(true);
    expect(isReservedBinding('shift+mod+v')).toBe(false);
    // Zoom In's real chord is the shifted plus (recorded via e.code).
    expect(isReservedBinding('shift+mod+=')).toBe(true);
    // …and the NumpadAdd form.
    expect(isReservedBinding('mod+plus')).toBe(true);
    expect(isReservedBinding('shift+mod+plus')).toBe(true);
    // The non-mac DevTools chord is NOT reserved on macOS.
    expect(isReservedBinding('shift+ctrl+i')).toBe(false);
    // Nor is Alt+F4 (no macOS system meaning).
    expect(isReservedBinding('alt+f4')).toBe(false);
    // Our own defaults stay assignable.
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
    // Non-mac paste-and-match-style (⇧⌃V) and Windows-only redo (Ctrl+Y).
    expect(isReservedBinding('shift+mod+v')).toBe(true);
    expect(isReservedBinding('mod+y')).toBe(true);
    expect(isReservedBinding('alt+f')).toBe(true);
    expect(isReservedBinding('alt+e')).toBe(true);
    expect(isReservedBinding('alt+v')).toBe(true);
    expect(isReservedBinding('alt+h')).toBe(true);
    // macOS-only chords must NOT collapse into ordinary combos here (ctrl
    // and mod merge on non-Apple): Ctrl+F / Alt+Ctrl+I / Ctrl+H stay free.
    expect(isReservedBinding('ctrl+f')).toBe(false);
    expect(isReservedBinding('mod+f')).toBe(false);
    expect(isReservedBinding('alt+ctrl+i')).toBe(false);
    expect(isReservedBinding('mod+h')).toBe(false);
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

describe('formatBindingKeys', () => {
  it('formats Apple keycaps', () => {
    stubPlatform('MacIntel');
    expect(formatBindingKeys('shift+mod+a')).toEqual(['⇧', '⌘', 'A']);
    expect(formatBindingKeys('alt+mod+s')).toEqual(['⌥', '⌘', 'S']);
    expect(formatBindingKeys('mod+,')).toEqual(['⌘', ',']);
    expect(formatBindingKeys('shift+enter')).toEqual(['⇧', '↵']);
    expect(formatBindingKeys('escape')).toEqual(['Esc']);
  });

  it('formats non-Apple keycaps', () => {
    stubPlatform('Win32');
    expect(formatBindingKeys('shift+mod+a')).toEqual(['Shift', 'Ctrl', 'A']);
    expect(formatBindingKeys('alt+mod+s')).toEqual(['Alt', 'Ctrl', 'S']);
  });

  it('returns [] for malformed bindings', () => {
    expect(formatBindingKeys('mod')).toEqual([]);
  });
});

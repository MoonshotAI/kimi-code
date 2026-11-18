
import { nextTick, reactive, watch } from 'vue';
import { bindingKeyNames, hasDesktopBridge } from '@moonshot-ai/app-core/lib';
import {
  isBrowserReservedBinding,
  isHardcodedBinding,
  isHardcodedFindBinding,
  isValidBinding,
  matchBinding,
  MENU_SYNCED_ACTIONS,
  SHORTCUT_ACTIONS,
  bindingsEquivalent,
  effectiveBinding,
  shortcutActionById,
  type ShortcutScope,
} from '../lib/keymap';
import { safeGetJson, safeSetJson, STORAGE_KEYS } from '@moonshot-ai/app-core/lib';
import type { ShortcutActionId } from '../../shared/action-ids';
import type { GlobalShortcutFailureReason, GlobalShortcutResult } from '../../shared/global-shortcut';
import { isMacosDesktop } from '@moonshot-ai/app-core/lib';

export type ShortcutOverrides = Record<string, string | null>;

function loadOverrides(): ShortcutOverrides {
  const raw = safeGetJson<unknown>(STORAGE_KEYS.shortcutOverrides);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: ShortcutOverrides = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const action = shortcutActionById(id);
    if (action === undefined) continue;
    if (value === null) {
      out[id] = null;
    } else if (typeof value === 'string' && isValidBinding(value, action.scope)) {
      if (isHardcodedBinding(value) || isHardcodedFindBinding(value)) {
        if (bindingsEquivalent(value, 'ctrl+enter') || bindingsEquivalent(value, 'mod+enter')) continue;
        out[id] = null;
        continue;
      }
      out[id] = value;
    }
  }
  return out;
}

const overrides = reactive<ShortcutOverrides>(loadOverrides());

export function resolvedBinding(id: string): string | null {
  const action = shortcutActionById(id);
  if (action === undefined) return null;
  return effectiveBinding(action, overrides);
}

export function resolvedBindingKeys(id: string): string[] {
  const binding = resolvedBinding(id);
  if (binding === null) return [];
  if (!hasDesktopBridge() && isBrowserReservedBinding(binding)) return [];
  return bindingKeyNames(binding);
}

export interface ShortcutTooltip {
  text: string;
  keys: string[];
}

export function shortcutTooltip(label: string, id: string): ShortcutTooltip {
  return { text: label, keys: resolvedBindingKeys(id) };
}

export function setShortcutBinding(id: string, binding: string | null): boolean {
  const action = shortcutActionById(id);
  if (action === undefined) return false;
  if (binding !== null && !isValidBinding(binding, action.scope)) return false;
  overrides[id] = binding;
  return true;
}

export function resetShortcutBinding(id: string): void {
  delete overrides[id];
}

export function resetAllShortcutBindings(): void {
  for (const id of Object.keys(overrides)) {
    delete overrides[id];
  }
}

export function isShortcutCustomized(id: string): boolean {
  return id in overrides;
}

export function useShortcutOverrides(): ShortcutOverrides {
  return overrides;
}

interface MenuShortcutBridge {
  setMenuShortcuts?: (bindings: Record<string, string | null>) => void;
}

function pushMenuShortcuts(): void {
  if (typeof window === 'undefined') return;
  const bridge = (window as { kimiDesktop?: MenuShortcutBridge }).kimiDesktop;
  if (typeof bridge?.setMenuShortcuts !== 'function') return;
  const bindings: Record<string, string | null> = {};
  for (const id of MENU_SYNCED_ACTIONS) {
    bindings[id] = resolvedBinding(id);
  }
  bridge.setMenuShortcuts(bindings);
}

const screenshotSupported = typeof window !== 'undefined' && (
  window as { kimiDesktop?: { isScreenshotSupported?: () => boolean } }
).kimiDesktop?.isScreenshotSupported?.() === true;
const GLOBAL_SHORTCUT_ACTIONS: readonly ['summonApp'] | readonly ['summonApp', 'captureScreenshot'] = screenshotSupported
  ? ['summonApp', 'captureScreenshot']
  : ['summonApp'];

interface GlobalShortcutBridge {
  setGlobalShortcut?: (action: string, binding: string | null) => Promise<GlobalShortcutResult>;
  setGlobalShortcutSuspended?: (suspended: boolean) => Promise<boolean>;
}

export const osGlobalFailures = reactive<Record<string, GlobalShortcutFailureReason>>({});
let globalQueue = Promise.resolve();
let recordingGlobalShortcut = false;
let mainRecordingSuspended = false;
const appliedOverrides = new Map<string, string | null | undefined>();

async function ensureResumed(bridge: GlobalShortcutBridge): Promise<boolean> {
  if (!mainRecordingSuspended) return true;
  try {
    await bridge.setGlobalShortcutSuspended?.(false);
  } catch {
    for (const id of GLOBAL_SHORTCUT_ACTIONS) osGlobalFailures[id] = 'conflicted';
    return false;
  }
  mainRecordingSuspended = false;
  return true;
}

async function pushGlobalShortcuts(force = false): Promise<void> {
  if (recordingGlobalShortcut) return;
  if (typeof window === 'undefined') return;
  const bridge = (window as { kimiDesktop?: GlobalShortcutBridge }).kimiDesktop;
  if (typeof bridge?.setGlobalShortcut !== 'function') return;
  if (!(await ensureResumed(bridge))) return;
  const setGlobalShortcut = bridge.setGlobalShortcut.bind(bridge);
  await Promise.all(GLOBAL_SHORTCUT_ACTIONS.map(async (id) => {
    const requested = overrides[id];
    if (!force && appliedOverrides.has(id) && appliedOverrides.get(id) === requested) {
      delete osGlobalFailures[id];
      return;
    }
    const result = await setGlobalShortcut(id, resolvedBinding(id))
      .catch((): GlobalShortcutResult => ({ ok: false, reason: 'conflicted' }));
    if (result.ok) {
      appliedOverrides.set(id, requested);
      delete osGlobalFailures[id];
    } else {
      appliedOverrides.delete(id);
      osGlobalFailures[id] = result.reason;
    }
  }));
}

export async function setGlobalShortcutRecording(suspended: boolean): Promise<void> {
  if (suspended) recordingGlobalShortcut = true;
  await nextTick();
  globalQueue = globalQueue.then(async () => {
    const bridge = (window as { kimiDesktop?: GlobalShortcutBridge }).kimiDesktop;
    try {
      await bridge?.setGlobalShortcutSuspended?.(suspended);
      mainRecordingSuspended = suspended;
    } catch {
      for (const id of GLOBAL_SHORTCUT_ACTIONS) osGlobalFailures[id] = 'conflicted';
    }
    if (!suspended) {
      recordingGlobalShortcut = false;
      await pushGlobalShortcuts(true);
    }
  });
  await globalQueue;
}

watch(
  overrides,
  () => {
    safeSetJson(STORAGE_KEYS.shortcutOverrides, { ...overrides });
    pushMenuShortcuts();
    globalQueue = globalQueue.then(() => pushGlobalShortcuts());
  },
  { deep: true, immediate: true },
);

const FOCUS_RETRY_THROTTLE_MS = 15_000;
let lastFocusRetryAt = 0;

if (typeof window !== 'undefined') {
  window.addEventListener('focus', () => {
    const now = Date.now();
    if (now - lastFocusRetryAt < FOCUS_RETRY_THROTTLE_MS) return;
    lastFocusRetryAt = now;
    globalQueue = globalQueue.then(() => pushGlobalShortcuts(true));
  });
}

export function matchShortcutAction(e: KeyboardEvent, scope: ShortcutScope): ShortcutActionId | null {
  for (const action of SHORTCUT_ACTIONS) {
    if (action.scope !== scope) continue;
    const binding = resolvedBinding(action.id);
    if (binding === null || !matchBinding(e, binding)) continue;
    if (!hasDesktopBridge() && isBrowserReservedBinding(binding)) continue;
    return action.id;
  }
  return null;
}

export function terminalPassesChordToPty(e: KeyboardEvent, actionId: string): boolean {
  if (actionId === 'toggleTerminal' || actionId === 'toggleRightPanel' || actionId === 'nextPanelTab' || actionId === 'previousPanelTab') return false;
  if (isMacosDesktop) return e.ctrlKey && !e.metaKey && !e.altKey;
  return true;
}

export function isTerminalCopyChord(e: KeyboardEvent): boolean {
  return !isMacosDesktop && matchBinding(e, 'ctrl+c');
}

export function isTerminalClearChord(e: KeyboardEvent): boolean {
  return isMacosDesktop && matchBinding(e, 'mod+k');
}

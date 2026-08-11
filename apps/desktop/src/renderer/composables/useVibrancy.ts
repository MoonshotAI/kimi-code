// apps/desktop/src/renderer/composables/useVibrancy.ts
// Desktop-only reactive "frosted sidebar" (macOS window vibrancy) toggle.
//
// The `vibrancy` class gates ONLY the paint rules that let the material read
// through; `macos-desktop` keeps the traffic-light / drag-region layout, which
// must survive an opt-out. Design + rationale: apps/desktop/docs/native-todos.md.

import { readonly, ref, type Ref } from 'vue';

import { isMacosDesktop } from '@moonshot-ai/app-core/lib';

// Subset of the preload `kimiDesktop` bridge this tracker needs.
interface VibrancyBridge {
  getVibrancy: () => Promise<boolean>;
  setVibrancy: (enabled: boolean) => void;
}

function bridge(): VibrancyBridge | undefined {
  return (window as { kimiDesktop?: VibrancyBridge }).kimiDesktop;
}

const enabled = ref(true);
let started = false;

function paintClass(on: boolean): void {
  document.documentElement.classList.toggle('vibrancy', on);
}

/** main.ts calls this once at boot (macOS desktop only). The paint class is
    seeded synchronously from the vibrancy state the main process pins into
    the renderer URL on every boot (protocol.ts), mirrored into sessionStorage
    like the desktopFlag markers so an SPA reload that dropped the boot query
    still seeds correctly — no optimistic tint flash for an opted-out user;
    the bridge read below then confirms. */
export function initVibrancy(): void {
  if (!isMacosDesktop || started) return;
  started = true;
  try {
    // A per-tab choice made after boot (the settings toggle writes
    // sessionStorage) outranks the boot-time URL pin, which can still be in
    // the address bar — stale — when a full reload happens.
    const cached = sessionStorage.getItem('kimi-vibrancy');
    if (cached === '0' || cached === '1') {
      enabled.value = cached === '1';
    } else {
      const pinned = new URLSearchParams(window.location.search).get('kimi_vibrancy');
      if (pinned === '0' || pinned === '1') {
        sessionStorage.setItem('kimi-vibrancy', pinned);
        enabled.value = pinned === '1';
      }
    }
  } catch {
    // sessionStorage unavailable — keep the default and let the bridge decide.
  }
  paintClass(enabled.value);
  const b = bridge();
  if (typeof b?.getVibrancy !== 'function') return; // older bridge: keep the default
  void b
    .getVibrancy()
    .then((on) => {
      enabled.value = on;
      paintClass(on);
    })
    .catch(() => {
      // Bridge failure: keep the optimistic default.
    });
}

export function useVibrancy(): {
  vibrancy: Readonly<Ref<boolean>>;
  setVibrancy: (on: boolean) => void;
} {
  function setVibrancy(on: boolean): void {
    enabled.value = on;
    if (isMacosDesktop) paintClass(on);
    try {
      sessionStorage.setItem('kimi-vibrancy', on ? '1' : '0');
    } catch {
      // sessionStorage unavailable — the next boot re-seeds from the URL pin.
    }
    try {
      bridge()?.setVibrancy?.(on);
    } catch {
      // Bridge failure: the visual state already flipped; the preference
      // just won't persist.
    }
  }
  return { vibrancy: readonly(enabled), setVibrancy };
}

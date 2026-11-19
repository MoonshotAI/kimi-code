
import { readonly, ref, type Ref } from 'vue';

import { isMacosDesktop } from '@moonshot-ai/app-core/lib';

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

export function initVibrancy(): void {
  if (!isMacosDesktop || started) return;
  started = true;
  try {
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
  } catch {}
  paintClass(enabled.value);
  const b = bridge();
  if (typeof b?.getVibrancy !== 'function') return;
  void b
    .getVibrancy()
    .then((on) => {
      enabled.value = on;
      paintClass(on);
    })
    .catch(() => {});
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
    } catch {}
    try {
      bridge()?.setVibrancy?.(on);
    } catch {}
  }
  return { vibrancy: readonly(enabled), setVibrancy };
}

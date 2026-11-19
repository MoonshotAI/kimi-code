import { ref, watch, type Ref } from 'vue';
import { STORAGE_KEYS, safeGetString, safeSetString } from '@moonshot-ai/app-core/lib';

export type DockIconChoice = 'light' | 'dark';

interface DockIconBridge {
  setDockIconChoice?: (choice: DockIconChoice) => void;
}

function bridge(): DockIconBridge | undefined {
  return (window as { kimiDesktop?: DockIconBridge }).kimiDesktop;
}

export function canSetDockIconChoice(): boolean {
  return typeof bridge()?.setDockIconChoice === 'function';
}

export function loadDockIconChoice(): DockIconChoice {
  const value = safeGetString(STORAGE_KEYS.dockIconChoice);
  return value === 'dark' ? 'dark' : 'light';
}

const choice: Ref<DockIconChoice> = ref(loadDockIconChoice());

function push(value: DockIconChoice): void {
  try {
    bridge()?.setDockIconChoice?.(value);
  } catch {}
}

watch(choice, (value) => {
  safeSetString(STORAGE_KEYS.dockIconChoice, value);
  push(value);
});

push(choice.value);

export function useDockIconChoice(): Ref<DockIconChoice> {
  return choice;
}

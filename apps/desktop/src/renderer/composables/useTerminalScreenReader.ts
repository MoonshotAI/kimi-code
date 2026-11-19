import { readonly, ref } from 'vue';

const KEY_TERMINAL_SCREEN_READER = 'kimi-web.terminal-screen-reader';

function loadTerminalScreenReader(): boolean {
  try {
    return globalThis.localStorage.getItem(KEY_TERMINAL_SCREEN_READER) === '1';
  } catch {
    return false;
  }
}

const terminalScreenReader = ref<boolean>(loadTerminalScreenReader());

function setTerminalScreenReader(on: boolean): void {
  terminalScreenReader.value = on;
  try {
    globalThis.localStorage.setItem(KEY_TERMINAL_SCREEN_READER, on ? '1' : '0');
  } catch {
    return;
  }
}

export function useTerminalScreenReader() {
  return {
    terminalScreenReader: readonly(terminalScreenReader),
    setTerminalScreenReader,
  };
}

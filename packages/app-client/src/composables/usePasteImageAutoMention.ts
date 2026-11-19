
import { ref } from 'vue';

const KEY_PASTE_IMAGE_AUTO_MENTION = 'kimi-web.paste-image-auto-mention';

function storageGet(key: string): string | null {
  try {
    return globalThis.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    globalThis.localStorage.setItem(key, value);
  } catch {
    return;
  }
}

function loadPasteImageAutoMention(): boolean {
  return storageGet(KEY_PASTE_IMAGE_AUTO_MENTION) === '1';
}

const pasteImageAutoMention = ref<boolean>(loadPasteImageAutoMention());

function setPasteImageAutoMention(on: boolean): void {
  pasteImageAutoMention.value = on;
  storageSet(KEY_PASTE_IMAGE_AUTO_MENTION, on ? '1' : '0');
}

export function usePasteImageAutoMention() {
  return {
    pasteImageAutoMention,
    setPasteImageAutoMention,
  };
}

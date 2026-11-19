import { onMounted, onUnmounted } from 'vue';
import { useFontPrefs } from '@moonshot-ai/app-core';

export interface TerminalFontOptions {
  fontFamily: string;
  fontSize: number;
}

export function useTerminalFonts(apply: (options: TerminalFontOptions) => void) {
  useFontPrefs();
  let observer: MutationObserver | undefined;
  let previous = '';

  function readOptions(): TerminalFontOptions {
    const root = getComputedStyle(document.documentElement);
    const probe = document.createElement('span');
    probe.style.fontSize = 'var(--terminal-font-size)';
    probe.hidden = true;
    document.body.appendChild(probe);
    const fontSize = Number.parseFloat(getComputedStyle(probe).fontSize);
    probe.remove();
    return {
      fontFamily: root.getPropertyValue('--font-terminal').trim(),
      fontSize,
    };
  }

  function sync(): void {
    const options = readOptions();
    const key = JSON.stringify(options);
    if (key === previous) return;
    previous = key;
    apply(options);
  }

  function onFontsLoaded(): void {
    apply(readOptions());
  }

  onMounted(() => {
    observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style', 'data-font-scale'],
    });
    document.fonts?.addEventListener('loadingdone', onFontsLoaded);
    sync();
  });

  onUnmounted(() => {
    observer?.disconnect();
    document.fonts?.removeEventListener('loadingdone', onFontsLoaded);
  });

  return { readOptions };
}

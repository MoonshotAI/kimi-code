<script setup lang="ts">
import '@xterm/xterm/css/xterm.css';

import type { FitAddon as FitAddonType } from '@xterm/addon-fit';
import type { Terminal as XTerm, ITheme } from '@xterm/xterm';
import { computed, nextTick, onDeactivated, onMounted, onUnmounted, ref, toRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useIsDark, useFontPrefs, effectiveFontPrefs, quoteFontFamily } from '@moonshot-ai/app-core';
import { copyTextToClipboard } from '@moonshot-ai/app-core/lib';
import { SelectionActionBubble } from '@moonshot-ai/app-components';
import type { SelectionActionPayload } from '@moonshot-ai/app-client/lib';
import { useNativeTerminal } from '../../composables/useNativeTerminal';
import {
  adoptTerminalInstance,
  registerTerminalInstance,
  releaseTerminalInstance,
  type TerminalInstance,
} from '../../composables/terminalInstances';
import { useTerminalSelectionQuote } from '../../composables/useTerminalSelectionQuote';
import { useTerminalScreenReader } from '../../composables/useTerminalScreenReader';
import { isTerminalClearChord, isTerminalCopyChord, matchShortcutAction, terminalPassesChordToPty } from '../../composables/useShortcuts';

const props = defineProps<{
  tabId: string;
  active: boolean;
  panelHost?: boolean;
}>();
const emit = defineEmits<{
  quoteAction: [payload: SelectionActionPayload];
}>();
const { t } = useI18n();

const TERMINAL_FONT =
  'ui-monospace, "SF Mono", SFMono-Regular, Menlo, "Cascadia Mono", Consolas, "Symbols Nerd Font Mono", "MesloLGS NF", "MesloLGS Nerd Font Mono", "JetBrainsMono Nerd Font Mono", "Hack Nerd Font Mono", "FiraCode Nerd Font Mono", monospace';

const hostRef = ref<HTMLElement | null>(null);
const tabId = toRef(props, 'tabId');
const store = useNativeTerminal();
const isDark = useIsDark();
const { fontPrefs } = useFontPrefs();
const terminalPrefs = computed(() => effectiveFontPrefs(fontPrefs.value, 'terminal'));

function terminalFontFamily(): string {
  const families = terminalPrefs.value.families;
  if (families.length === 0) return TERMINAL_FONT;
  return `${families.map(quoteFontFamily).join(', ')}, ${TERMINAL_FONT}`;
}

function terminalFontSize(): number {
  return terminalPrefs.value.size ?? tokenPx('--md-b2', 13);
}

function applyTerminalFontPrefs(): void {
  if (!term) return;
  term.options.fontFamily = terminalFontFamily();
  term.options.fontSize = terminalFontSize();
  scheduleFit();
}

watch(terminalPrefs, applyTerminalFontPrefs);
const { terminalScreenReader } = useTerminalScreenReader();

let term: XTerm | null = null;
let fitAddon: FitAddonType | null = null;
let resizeObserver: ResizeObserver | null = null;
let fontScaleObserver: MutationObserver | null = null;
let resizeTimer: ReturnType<typeof setTimeout> | null = null;
let disposeOutput: (() => void) | null = null;
let disposeExit: (() => void) | null = null;
let unmounted = false;
let menuFocusSetByUs = false;
const instanceOwner = Symbol('terminal-view');

const quoteBridge = useTerminalSelectionQuote({
  onAction: (payload) => emit('quoteAction', payload),
});

function setTerminalMenuFocus(focused: boolean): void {
  const bridge = (window as { kimiDesktop?: { setTerminalMenuFocus?: (flag: boolean) => void } })
    .kimiDesktop;
  if (typeof bridge?.setTerminalMenuFocus !== 'function') return;
  if (menuFocusSetByUs === focused) return;
  menuFocusSetByUs = focused;
  bridge.setTerminalMenuFocus(focused);
}

function onFocusIn(): void {
  setTerminalMenuFocus(true);
}

function onFocusOut(): void {
  setTerminalMenuFocus(false);
}

function tokenColor(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value === '' ? fallback : value;
}

function tokenPx(name: string, fallback: number): number {
  if (typeof document === 'undefined') return fallback;
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;visibility:hidden;';
  probe.style.fontSize = `var(${name})`;
  document.body.appendChild(probe);
  const px = Number.parseFloat(getComputedStyle(probe).fontSize);
  probe.remove();
  return Number.isFinite(px) && px > 0 ? px : fallback;
}

const theme = computed<ITheme>(() => {
  const dark = isDark.value;
  return {
    background: tokenColor('--color-bg', dark ? '#121212' : '#ffffff'),
    foreground: tokenColor('--color-text', dark ? '#e6edf3' : '#1f2328'),
    cursor: tokenColor('--color-accent', '#7aa2ff'),
    selectionBackground: tokenColor('--color-accent-soft', dark ? '#264f78' : '#c8e1ff'),
    black: tokenColor('--color-term-black', dark ? '#484f58' : '#24292f'),
    red: tokenColor('--color-danger', dark ? '#ff7b72' : '#cf222e'),
    green: tokenColor('--color-success', dark ? '#7ee787' : '#116329'),
    yellow: tokenColor('--color-warning', dark ? '#f2cc60' : '#9a6700'),
    blue: tokenColor('--color-accent', dark ? '#7aa2ff' : '#0969da'),
    magenta: tokenColor('--color-term-magenta', dark ? '#d2a8ff' : '#8250df'),
    cyan: tokenColor('--color-term-cyan', dark ? '#76e3ea' : '#1b7c83'),
    white: tokenColor('--color-text', dark ? '#e6edf3' : '#1f2328'),
  };
});

function fitAndResize(): void {
  if (!term || !fitAddon || !hostRef.value) return;
  if (hostRef.value.clientWidth <= 0 || hostRef.value.clientHeight <= 0) return;
  try {
    fitAddon.fit();
    store.resize(tabId.value, term.cols, term.rows);
  } catch {
    // xterm-fit can throw while layout is settling; the next resize retries.
  }
}

function scheduleFit(): void {
  if (resizeTimer !== null) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    resizeTimer = null;
    fitAndResize();
  }, 100);
}

async function initTerminal(): Promise<void> {
  if (!hostRef.value || term) return;
  const [{ Terminal: XTermCtor }, { FitAddon: FitAddonCtor }, { WebLinksAddon: WebLinksAddonCtor }, { WebglAddon: WebglAddonCtor }] =
    await Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
      import('@xterm/addon-web-links'),
      import('@xterm/addon-webgl'),
    ]);
  if (typeof document !== 'undefined' && document.fonts?.ready) {
    try {
      await document.fonts.ready;
    } catch {
      // fonts API unavailable — proceed with the fallback metric
    }
  }
  if (unmounted || !hostRef.value || term) return;
  const next = new XTermCtor({
    cursorBlink: true,
    convertEol: true,
    fontFamily: terminalFontFamily(),
    fontSize: terminalFontSize(),
    lineHeight: 1.1,
    letterSpacing: 0,
    scrollback: 4000,
    screenReaderMode: terminalScreenReader.value,
    theme: theme.value,
  });
  const fit = new FitAddonCtor();
  next.loadAddon(fit);
  next.loadAddon(
    new WebLinksAddonCtor((_event, uri) => {
      window.open(uri, '_blank', 'noopener');
    }),
  );
  next.open(hostRef.value);
  try {
    const webgl = new WebglAddonCtor();
    webgl.onContextLoss(() => webgl.dispose());
    next.loadAddon(webgl);
  } catch {}
  const id = tabId.value;
  next.onData((data) => store.write(id, data));
  next.onResize(({ cols, rows }) => store.resize(id, cols, rows));
  next.attachCustomKeyEventHandler((event) => {
    if (isTerminalClearChord(event)) {
      event.preventDefault();
      next.clear();
      return false;
    }
    if (isTerminalCopyChord(event) && next.hasSelection()) {
      event.preventDefault();
      void copyTextToClipboard(next.getSelection());
      next.clearSelection();
      return false;
    }
    const action = matchShortcutAction(event, 'global');
    if (action !== null && terminalPassesChordToPty(event, action)) return true;
    return action === null;
  });
  const instance: TerminalInstance = { term: next, fit };
  registerTerminalInstance(id, instance, instanceOwner);
  bindInstance(instance);
  const current =
    store.tabs.value.find((tab) => tab.id === id) ?? store.panelTabOf(id);
  if (current?.status === 'exited') {
    printExit(current.exitCode);
  }
}

function bindInstance(instance: TerminalInstance): void {
  const host = hostRef.value;
  if (!host) return;
  term = instance.term;
  fitAddon = instance.fit;
  if (instance.term.options.screenReaderMode !== terminalScreenReader.value) {
    instance.term.options.screenReaderMode = terminalScreenReader.value;
  }
  quoteBridge.attach(instance.term);
  host.addEventListener('focusin', onFocusIn);
  host.addEventListener('focusout', onFocusOut);

  disposeOutput = store.onOutput(tabId.value, (data, truncated) => {
    if (truncated) term?.writeln(t('terminal.outputTruncated'));
    term?.write(data);
  });
  disposeExit = store.onExit(tabId.value, printExit);

  resizeObserver = new ResizeObserver(scheduleFit);
  resizeObserver.observe(host);
  if (typeof MutationObserver !== 'undefined') {
    fontScaleObserver = new MutationObserver(() => {
      if (!term) return;
      if (terminalPrefs.value.size !== null) return;
      const px = tokenPx('--md-b2', 13);
      if (px === term.options.fontSize) return;
      term.options.fontSize = px;
      scheduleFit();
    });
    fontScaleObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-font-scale'],
    });
  }
}

function printExit(exitCode: number | null): void {
  term?.writeln('');
  term?.writeln(
    exitCode === null
      ? t('terminal.processExited')
      : t('terminal.processExitedWithCode', { code: exitCode }),
  );
}

function focusTerm(): void {
  term?.focus();
}

function focusUnlessPanelBusy(): void {
  const el = document.activeElement;
  if (el instanceof HTMLElement && el.closest('.tp, .panel-tab-bar') !== null) return;
  term?.focus();
}

function adoptMovedInstance(instance: TerminalInstance): void {
  const element = instance.term.element;
  if (!hostRef.value || !element) return;
  const { viewportY, baseY } = instance.term.buffer.active;
  const restoreScroll = (): void => {
    if (viewportY >= baseY) instance.term.scrollToBottom();
    else instance.term.scrollToLine(viewportY);
  };
  hostRef.value.appendChild(element);
  bindInstance(instance);
  fitAndResize();
  restoreScroll();
  requestAnimationFrame(restoreScroll);
  instance.term.refresh(0, instance.term.rows - 1);
  void nextTick(() => {
    if (props.active) focusTerm();
  });
}

onMounted(() => {
  const moved = adoptTerminalInstance(tabId.value, instanceOwner);
  if (moved) {
    adoptMovedInstance(moved);
    return;
  }
  void initTerminal().then(() => {
    fitAndResize();
    if (props.active) focusUnlessPanelBusy();
  });
});

watch(theme, (nextTheme) => {
  if (term) term.options.theme = nextTheme;
});

watch(terminalScreenReader, (enabled) => {
  if (term) term.options.screenReaderMode = enabled;
});

watch(
  () => props.active,
  (active) => {
    if (active) {
      void nextTick(() => {
        fitAndResize();
        focusUnlessPanelBusy();
      });
    } else {
      quoteBridge.dismiss();
    }
  },
);

watch(store.open, (isOpen) => {
  if (props.panelHost) return;
  if (isOpen && props.active) {
    void nextTick(() => {
      fitAndResize();
      focusUnlessPanelBusy();
    });
  }
  if (!isOpen) {
    setTerminalMenuFocus(false);
    quoteBridge.dismiss();
  }
});

onDeactivated(() => {
  setTerminalMenuFocus(false);
  quoteBridge.dismiss();
});

onUnmounted(() => {
  unmounted = true;
  if (resizeTimer !== null) clearTimeout(resizeTimer);
  resizeObserver?.disconnect();
  fontScaleObserver?.disconnect();
  fontScaleObserver = null;
  disposeOutput?.();
  disposeExit?.();
  hostRef.value?.removeEventListener('focusin', onFocusIn);
  hostRef.value?.removeEventListener('focusout', onFocusOut);
  setTerminalMenuFocus(false);
  quoteBridge.detach();
  if (releaseTerminalInstance(tabId.value, instanceOwner)) term?.dispose();
  term = null;
  fitAddon = null;
});

defineExpose({ fit: fitAndResize, focus: focusTerm });
</script>

<template>
  <div ref="hostRef" class="terminal-host" :style="{ '--term-bg': theme.background }" @pointerdown="quoteBridge.onHostPointerdown" @mouseup="quoteBridge.onHostMouseup">
    <SelectionActionBubble
      :visible="quoteBridge.anchor.value !== null"
      :x="quoteBridge.anchor.value?.x ?? 0"
      :y="quoteBridge.anchor.value?.y ?? 0"
      :bottom="quoteBridge.anchor.value?.bottom ?? 0"
      :px="quoteBridge.anchor.value?.px"
      :py="quoteBridge.anchor.value?.py"
      :quote="quoteBridge.anchor.value?.quote ?? ''"
      @action="quoteBridge.onBubbleAction"
      @close="quoteBridge.onBubbleClose"
    />
  </div>
</template>

<style scoped>
.terminal-host {
  position: absolute;
  inset: 0;
  background: var(--term-bg);
}
.terminal-host :deep(.xterm) {
  padding: var(--space-2);
  height: 100%;
}
.terminal-host :deep(.xterm .xterm-accessibility) {
  inset: var(--space-2);
}
.terminal-host :deep(.xterm),
.terminal-host :deep(.xterm-viewport) {
  background-color: var(--term-bg);
}
</style>

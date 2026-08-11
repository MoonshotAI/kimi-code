<!-- apps/desktop/src/renderer/components/terminal/TerminalView.vue -->
<!-- Desktop-only: one xterm instance bound to a main-process PTY tab -->
<!-- (composables/useNativeTerminal.ts); the data path is the native bridge. -->
<script setup lang="ts">
import '@xterm/xterm/css/xterm.css';

import type { FitAddon as FitAddonType } from '@xterm/addon-fit';
import type { Terminal as XTerm, ITheme } from '@xterm/xterm';
import { computed, nextTick, onMounted, onUnmounted, ref, toRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useIsDark } from '@moonshot-ai/app-core';
import { useNativeTerminal } from '../../composables/useNativeTerminal';
import { matchShortcutAction, terminalPassesChordToPty } from '../../composables/useShortcuts';

const props = defineProps<{ tabId: string; active: boolean }>();
const { t } = useI18n();

// xterm's fontFamily is a literal font string — CSS variables do not resolve.
const TERMINAL_FONT =
  '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

const hostRef = ref<HTMLElement | null>(null);
const tabId = toRef(props, 'tabId');
const store = useNativeTerminal();
const isDark = useIsDark();

let term: XTerm | null = null;
let fitAddon: FitAddonType | null = null;
let resizeObserver: ResizeObserver | null = null;
let fontScaleObserver: MutationObserver | null = null;
let resizeTimer: ReturnType<typeof setTimeout> | null = null;
let disposeOutput: (() => void) | null = null;
let disposeExit: (() => void) | null = null;
let unmounted = false;
// While xterm owns focus, native menu accelerators go silent so Ctrl chords
// reach the PTY; click handlers stay live.
let menuFocusSetByUs = false;

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

// xterm's canvas cannot resolve CSS variables — the palette is read from
// live tokens (re-run on scheme flips).
function tokenColor(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value === '' ? fallback : value;
}

// Measure the token through a probe — custom-property calc()s don't resolve
// via getPropertyValue.
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
  const [{ Terminal: XTermCtor }, { FitAddon: FitAddonCtor }] = await Promise.all([
    import('@xterm/xterm'),
    import('@xterm/addon-fit'),
  ]);
  // Wait for the variable font before xterm measures the cell.
  if (typeof document !== 'undefined' && document.fonts?.ready) {
    try {
      await document.fonts.ready;
    } catch {
      // fonts API unavailable — proceed with the fallback metric
    }
  }
  // The awaits above give a quick tab close / reset time to unmount this
  // view — opening xterm against a dead host would throw unhandled.
  if (unmounted || !hostRef.value || term) return;
  const next = new XTermCtor({
    cursorBlink: true,
    convertEol: true,
    fontFamily: TERMINAL_FONT,
    // Font size rides the content token scale; lineHeight keeps terminal density.
    fontSize: tokenPx('--md-b2', 13),
    lineHeight: 1.1,
    letterSpacing: 0,
    scrollback: 4000,
    theme: theme.value,
  });
  const fit = new FitAddonCtor();
  next.loadAddon(fit);
  next.open(hostRef.value);
  next.onData((data) => store.write(tabId.value, data));
  next.onResize(({ cols, rows }) => store.resize(tabId.value, cols, rows));
  // Returning false for a registered global shortcut lets it bubble to the
  // App dispatcher; menu-suspended chords pass through (terminalPassesChordToPty).
  next.attachCustomKeyEventHandler((event) => {
    const action = matchShortcutAction(event, 'global');
    if (action !== null && terminalPassesChordToPty(event, action)) return true;
    return action === null;
  });
  term = next;
  fitAddon = fit;
  hostRef.value.addEventListener('focusin', onFocusIn);
  hostRef.value.addEventListener('focusout', onFocusOut);

  disposeOutput = store.onOutput(tabId.value, (data) => {
    term?.write(data);
  });
  disposeExit = store.onExit(tabId.value, printExit);
  // The PTY may have exited before this view subscribed (early exit — the
  // store tracks it on the tab) — print the status line it missed.
  const current = store.tabs.value.find((tab) => tab.id === tabId.value);
  if (current?.status === 'exited') {
    printExit(current.exitCode);
  }

  resizeObserver = new ResizeObserver(scheduleFit);
  resizeObserver.observe(hostRef.value);
  // data-font-scale on <html> moves --md-b2 — re-resolve and re-fit so an
  // open terminal honors the change without a recreate.
  if (typeof MutationObserver !== 'undefined') {
    fontScaleObserver = new MutationObserver(() => {
      if (!term) return;
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

/** Focus xterm unless the focus is already inside the panel UI (tab strip /
 *  toolbar buttons): stealing it would break roving-tabindex arrow browsing
 *  and keyboard access to the panel's own controls. */
function focusUnlessPanelBusy(): void {
  const el = document.activeElement;
  if (el instanceof HTMLElement && el.closest('.tp') !== null) return;
  term?.focus();
}

onMounted(() => {
  void initTerminal().then(() => {
    fitAndResize();
    // The active watcher only fires on CHANGE — an already-active view (first
    // tab, panel just opened) must grab focus explicitly.
    if (props.active) focusUnlessPanelBusy();
  });
});

watch(theme, (nextTheme) => {
  if (term) term.options.theme = nextTheme;
});

// Becoming visible again (tab switch / panel reopen): re-measure — a hidden
// host reports 0×0.
watch(
  () => props.active,
  (active) => {
    if (active) {
      void nextTick(() => {
        fitAndResize();
        focusUnlessPanelBusy();
      });
    }
  },
);

// Panel reopen re-fits and re-focuses (a hidden host measured 0×0); collapse
// hands the menu back even with focus still inside the now-inert panel.
watch(store.open, (isOpen) => {
  if (isOpen && props.active) {
    void nextTick(() => {
      fitAndResize();
      focusUnlessPanelBusy();
    });
  }
  if (!isOpen) {
    setTerminalMenuFocus(false);
  }
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
  term?.dispose();
  term = null;
  fitAddon = null;
});

defineExpose({ fit: fitAndResize, focus: focusTerm });
</script>

<template>
  <div ref="hostRef" class="terminal-host" :style="{ '--term-bg': theme.background }"></div>
</template>

<style scoped>
.terminal-host {
  position: absolute;
  inset: 0;
  padding: var(--space-2);
  background: var(--term-bg);
}
/* xterm 6 keeps the viewport layer at the stylesheet default (#000) instead
   of following the theme — the canvas covers only the rows area, so the
   bottom/right strips (and the first paint before the themed frame) show
   black. Pin every layer to the active theme color. */
.terminal-host :deep(.xterm),
.terminal-host :deep(.xterm-viewport) {
  background-color: var(--term-bg);
}
.terminal-host :deep(.xterm) {
  height: 100%;
}
</style>

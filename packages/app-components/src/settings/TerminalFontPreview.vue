<script setup lang="ts">
import '@xterm/xterm/css/xterm.css';
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useIsDark } from '@moonshot-ai/app-core/composables';
import { useTerminalFonts } from '@moonshot-ai/app-client/composables';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { terminalPreviewScreen } from './terminalPreviewScreen';

const host = ref<HTMLElement>();
const isDark = useIsDark();
let term: Terminal | undefined;
let fit: FitAddon | undefined;
let observer: ResizeObserver | undefined;
let disposed = false;
let fitFrame: number | undefined;

function theme() {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string) => style.getPropertyValue(name).trim();
  return {
    background: token('--color-bg'),
    foreground: token('--color-text'),
    cursor: token('--color-accent'),
    selectionBackground: token('--color-accent-soft'),
    green: token('--color-success'),
    blue: token('--color-accent'),
    brightBlue: token('--color-accent'),
    brightBlack: token('--color-text-muted'),
  };
}

function fitPreview(): void {
  if (fitFrame !== undefined) cancelAnimationFrame(fitFrame);
  fitFrame = requestAnimationFrame(() => {
    fitFrame = undefined;
    if (disposed || !host.value?.clientWidth || !host.value.clientHeight || !term || !fit) return;
    fit.fit();
    writeSample();
  });
}

function writeSample(): void {
  if (!term) return;
  const screen = terminalPreviewScreen(term.cols, term.rows);
  term.reset();
  term.write('\x1b[?25l\x1b[2J\x1b[H' + screen.lines.join('\r\n')
    + `\x1b[${screen.cursorRow};${screen.cursorColumn}H\x1b[?25h`);
}

const fonts = useTerminalFonts((options) => {
  if (!term) return;
  term.options = options;
  fitPreview();
});

onMounted(async () => {
  const [{ Terminal: XTerm }, { FitAddon: Fit }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
  await document.fonts.ready;
  if (disposed || !host.value) return;
  term = new XTerm({
    ...fonts.readOptions(),
    theme: theme(),
    lineHeight: Number(getComputedStyle(document.documentElement).getPropertyValue('--terminal-line-height')),
    letterSpacing: 0,
    disableStdin: true,
    cursorBlink: false,
    cursorStyle: 'bar',
    cursorInactiveStyle: 'bar',
    scrollback: 0,
    convertEol: true,
  });
  fit = new Fit();
  term.loadAddon(fit);
  term.open(host.value);
  if (term.textarea) term.textarea.tabIndex = -1;
  await nextTick();
  if (disposed) return;
  fitPreview();
  observer = new ResizeObserver(fitPreview);
  observer.observe(host.value);
});

watch(isDark, () => {
  if (term) term.options.theme = theme();
});
onUnmounted(() => {
  disposed = true;
  if (fitFrame !== undefined) cancelAnimationFrame(fitFrame);
  observer?.disconnect();
  term?.dispose();
  term = undefined;
});
</script>

<template>
  <div ref="host" class="terminal-font-preview" aria-hidden="true"></div>
</template>

<style scoped>
.terminal-font-preview {
  height: 100%;
  min-width: 0;
}
.terminal-font-preview :deep(.xterm-viewport) {
  background-color: var(--color-bg);
}
.terminal-font-preview :deep(.xterm) {
  height: 100%;
}
</style>

<!-- apps/kimi-web/src/debug/DebugPanel.vue
     KAP/daemon debug panel — opt-in (?debug=1 or localStorage kimi-web.debug=1).
     This is the CONTROLLER: it pops the panel out into a real, separate browser
     window. The panel app is created from THIS window's JS context, so it shares
     the live trace ring buffer (reactivity flows across the window boundary). We
     copy the app's stylesheets + theme attributes into the popup so it looks the
     same. Dev tooling: labels are intentionally not localized. -->
<script setup lang="ts">
import { createApp, onBeforeUnmount, onMounted, ref, type App } from 'vue';
import KapDebugView from './KapDebugView.vue';
import Tooltip from '../components/ui/Tooltip.vue';

const isOpen = ref(false);

let kapWin: Window | null = null;
let kapApp: App | null = null;
let themeObserver: MutationObserver | null = null;

const THEME_ATTRS = ['data-color-scheme', 'data-accent'] as const;

function syncThemeAttrs(doc: Document): void {
  const src = document.documentElement;
  const dst = doc.documentElement;
  for (const name of THEME_ATTRS) {
    const v = src.getAttribute(name);
    if (v !== null) dst.setAttribute(name, v);
    else dst.removeAttribute(name);
  }
}

function setupPopupDocument(win: Window): HTMLElement {
  const doc = win.document;
  doc.title = 'KAP debug';
  // <base> so root-relative asset URLs (fonts) in cloned CSS resolve to the app.
  const base = doc.createElement('base');
  base.href = location.href;
  doc.head.appendChild(base);
  // Clone every stylesheet so CSS variables, fonts, and scoped component styles
  // apply in the popup.
  for (const node of Array.from(document.querySelectorAll('style, link[rel="stylesheet"]'))) {
    doc.head.appendChild(node.cloneNode(true));
  }
  syncThemeAttrs(doc);
  doc.body.style.margin = '0';
  const mount = doc.createElement('div');
  mount.style.height = '100vh';
  doc.body.appendChild(mount);
  return mount;
}

function teardown(): void {
  themeObserver?.disconnect();
  themeObserver = null;
  try { kapApp?.unmount(); } catch { /* ignore */ }
  kapApp = null;
  kapWin = null;
  isOpen.value = false;
}

function openKapWindow(): void {
  if (kapWin && !kapWin.closed) {
    kapWin.focus();
    return;
  }
  const win = window.open('', 'kap-debug', 'popup=yes,width=1040,height=760');
  if (!win) return; // popup blocked — the FAB stays so a click (a user gesture) can retry
  kapWin = win;

  const mount = setupPopupDocument(win);
  const app = createApp(KapDebugView, { onClose: () => win.close() });
  app.mount(mount);
  kapApp = app;
  isOpen.value = true;

  // Keep the popup's theme in sync with the main window while it's open.
  themeObserver = new MutationObserver(() => {
    if (kapWin && !kapWin.closed) syncThemeAttrs(kapWin.document);
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: [...THEME_ATTRS] });

  win.addEventListener('pagehide', teardown);
  win.addEventListener('beforeunload', teardown);
}

// Best-effort auto pop-out: debug is opt-in, so "?debug=1 → window pops out".
// A popup blocker may deny this non-gesture open; the FAB then opens it on click.
onMounted(() => {
  openKapWindow();
});

onBeforeUnmount(() => {
  if (kapWin && !kapWin.closed) kapWin.close();
  teardown();
});
</script>

<template>
  <!-- The launcher stays in the corner: opens the KAP window, or refocuses it. -->
  <Tooltip :text="isOpen ? 'Focus KAP debug window' : 'Open KAP debug window'">
    <button class="kap-fab" type="button" @click="openKapWindow">
      KAP
    </button>
  </Tooltip>
</template>

<style scoped>
.kap-fab {
  position: fixed;
  right: 10px;
  bottom: 10px;
  z-index: var(--z-overlay);
  padding: 5px 9px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
  color: var(--muted);
  font-family: var(--mono);
  font-size: calc(var(--ui-font-size) - 3px);
  font-weight: 500;
  letter-spacing: 0.04em;
  cursor: pointer;
  opacity: 0.75;
}
.kap-fab:hover { opacity: 1; color: var(--color-accent); }
</style>

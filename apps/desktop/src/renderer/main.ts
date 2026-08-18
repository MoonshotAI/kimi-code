import { createApp } from 'vue';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import { KimiWebClientFacadeKey } from '@moonshot-ai/app-core';
import { KimiI18nKey, type KimiI18nApi } from '@moonshot-ai/app-i18n';
import App from './App.vue';
import i18n from './i18n';
import { useKimiWebClient, setKimiClientDeps } from '@moonshot-ai/app-client/client';
import { clientPinia } from '@moonshot-ai/app-client/stores';
import { initVibrancy } from './composables/useVibrancy';
import { isDesktop, isMacosDesktop } from '@moonshot-ai/app-core/lib';
import { getIcon, type IconName } from '@moonshot-ai/app-client/icons';
import { installClientErrorCapture, sessionExportTraceToJsonl, traceClientEvent, traceKeyEvent } from './debug/trace';
import { setProductTracker } from '@moonshot-ai/app-client/contracts';
import { productTracker } from './lib/track';
import { getKimiWebApi } from './api';
import { nativeTerminalDraftKey, useNativeTerminal } from './composables/useNativeTerminal';
import { handlePluginsShelfEvent } from './composables/usePlugins';
import { consumeSessionIntent } from './lib/session-intent';
import '@fontsource-variable/jetbrains-mono/wght.css';
import './style.css';

// Always retain bounded metadata for uncaught failures. With ?debug=1 / the
// debug flag, console output is included too; HMR restores listeners/wrappers.
installClientErrorCapture();

// Desktop bridges its renderer telemetry into app-client's ProductTracker so
// the shared composables' events reach the main process; web keeps the
// default no-op (it does not emit these events).
setProductTracker(productTracker);

// Wire the shared client singletons' platform seams (app-client/client): the
// composed api singleton, i18n translator, trace ring, plus desktop's native
// terminal teardown / session intent / plugins shelf fan-out. Web registers
// only the first group — the optional hooks stay no-op there.
setKimiClientDeps({
  api: getKimiWebApi,
  t: (key, params) => (params === undefined ? i18n.global.t(key) : i18n.global.t(key, params)),
  traceClientEvent,
  traceKeyEvent: (event, info) => traceKeyEvent(event as never, info),
  sessionExportTraceToJsonl,
  onSessionDestroyed: (sessionId) => useNativeTerminal().destroySession(sessionId),
  onWorkspaceDestroyed: (workspaceId, _root, sessionIds) => {
    const terminals = useNativeTerminal();
    for (const id of sessionIds) terminals.destroySession(id);
    terminals.destroySession(nativeTerminalDraftKey(workspaceId));
  },
  consumeSessionIntent,
  onPluginsShelfEvent: (event) => handlePluginsShelfEvent(event as never),
});

const app = createApp(App).use(i18n);
// Install the package-held pinia instance (app-client/stores): the domain
// stores' truth source, shared with the client singletons' module-level code.
app.use(clientPinia);
// Hand packages (e.g. app-markdown) a translator without forcing them to import
// the global vue-i18n. Wrap the composer as a minimal `KimiI18nApi` (its `locale`
// is a Ref, not a string), so `inject(KimiI18nKey)` stays type-safe.
const kimiI18n: KimiI18nApi = {
  t: (key, params) => i18n.global.t(key, params as never),
};
app.provide(KimiI18nKey, kimiI18n);
// Bridge app-ui's <Icon> to this app's icon registry: <Icon name> resolves its
// component through lib/icons.ts (which owns the `~icons/*` collections). The
// registry stays in apps/web; app-ui only defines the injection key.
app.provide(IconResolverKey, (name) => getIcon(name as IconName)?.component);
// Expose the web client singleton facade so (future) web-shell components can
// `inject(KimiWebClientFacadeKey)` instead of importing the composable. Provided
// before mount so the facade is ready when children inject during render.
app.provide(KimiWebClientFacadeKey, useKimiWebClient());

// macOS desktop: flag the root for the traffic-light / drag-region layout,
// then seed the vibrancy paint class (composables/useVibrancy.ts) — the
// window carries a native vibrancy material (see src/main/window.ts) that
// must read through the sidebar column unless the user switched it off.
// Seeded BEFORE mount so an opted-out user never renders the tint classes
// for even one frame.
if (isMacosDesktop) {
  document.documentElement.classList.add('macos-desktop');
  initVibrancy();
}

app.mount('#app');

// In the desktop app, mirror <html data-color-scheme> to the host's nativeTheme
// via the preload-exposed IPC (replaces the main process's console-message hack).
if (isDesktop) {
  const bridge = (window as unknown as { kimiDesktop?: { setTheme: (s: 'light' | 'dark' | 'system') => void } }).kimiDesktop;
  if (bridge) {
    const report = () => {
      const v = document.documentElement.dataset.colorScheme;
      bridge.setTheme(v === 'light' || v === 'dark' ? v : 'system');
    };
    new MutationObserver(report).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-color-scheme'],
    });
    report();
  }
}

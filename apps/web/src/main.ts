import { createApp } from 'vue';
import { IconResolverKey } from '@moonshot-ai/web-ui';
import App from './App.vue';
import i18n from './i18n';
import { isDesktop } from './lib/desktopFlag';
import { getIcon, type IconName } from './lib/icons';
import { installClientErrorCapture } from './debug/trace';
import '@fontsource-variable/inter/opsz.css';
import '@fontsource-variable/inter/opsz-italic.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import './style.css';

// Opt-in (only with ?debug=1 / the debug flag): fold front-end errors and
// console.error/warn into the trace buffer so the panel's "export jsonl" gives
// a complete troubleshooting log, not just network traffic.
installClientErrorCapture();

const app = createApp(App).use(i18n);
// Bridge web-ui's <Icon> to this app's icon registry: <Icon name> resolves its
// component through lib/icons.ts (which owns the `~icons/*` collections). The
// registry stays in apps/web; web-ui only defines the injection key.
app.provide(IconResolverKey, (name) => getIcon(name as IconName)?.component);
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

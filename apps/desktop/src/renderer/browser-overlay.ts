import { createApp } from 'vue';
import { useAppearance, useFontPrefs } from '@moonshot-ai/app-core';
import { STORAGE_KEYS } from '@moonshot-ai/app-core/lib';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import { createKimiI18n, detect } from '@moonshot-ai/app-i18n';
import { getIcon, type IconName } from '@moonshot-ai/app-client/icons';
import BrowserOverlayMenu from './components/browser-overlay/BrowserOverlayMenu.vue';
import './style.css';

const appearance = useAppearance();
useFontPrefs();
const i18n = createKimiI18n({ locale: detect() });
window.addEventListener('storage', event => {
  if (event.key === 'kimi-web.color-scheme' && (event.newValue === 'light' || event.newValue === 'dark' || event.newValue === 'system')) appearance.setColorScheme(event.newValue);
  if (event.key === 'kimi-web.font-scale' && (event.newValue === 'small' || event.newValue === 'medium' || event.newValue === 'large' || event.newValue === 'xlarge')) appearance.setFontScale(event.newValue);
  if (event.key === STORAGE_KEYS.locale) i18n.global.locale.value = detect();
});

const app = createApp(BrowserOverlayMenu);
app.use(i18n);
app.provide(IconResolverKey, (name) => getIcon(name as IconName)?.component);
app.mount('#app');

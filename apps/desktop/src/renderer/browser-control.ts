import { createApp } from 'vue';
import { useAppearance, useFontPrefs } from '@moonshot-ai/app-core';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import { getIcon, type IconName } from '@moonshot-ai/app-ui/icons';
import BrowserControlSurface from './components/browser/BrowserControlSurface.vue';
import './style.css';

const appearance = useAppearance();
useFontPrefs();
window.addEventListener('storage', event => {
  if (event.key === 'kimi-web.color-scheme' && (event.newValue === 'light' || event.newValue === 'dark' || event.newValue === 'system')) appearance.setColorScheme(event.newValue);
  if (event.key === 'kimi-web.font-scale' && (event.newValue === 'small' || event.newValue === 'medium' || event.newValue === 'large' || event.newValue === 'xlarge')) appearance.setFontScale(event.newValue);
});

const app = createApp(BrowserControlSurface);
app.provide(IconResolverKey, (name) => getIcon(name as IconName)?.component);
app.mount('#app');

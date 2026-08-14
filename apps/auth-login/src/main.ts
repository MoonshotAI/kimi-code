import { createApp } from 'vue';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import { KimiI18nKey, type KimiI18nApi } from '@moonshot-ai/app-i18n';
import { getIcon, type IconName } from '@moonshot-ai/app-client/icons';
import App from './App.vue';
import i18n from './i18n';
import './style.css';

document.documentElement.lang = i18n.global.locale.value === 'zh' ? 'zh-CN' : 'en';

const app = createApp(App).use(i18n);
// Let package components (e.g. Spinner's aria label) translate without
// importing the global vue-i18n directly.
const kimiI18n: KimiI18nApi = {
  t: (key, params) => i18n.global.t(key, params as never),
  locale: i18n.global.locale.value,
};
app.provide(KimiI18nKey, kimiI18n);
// Bridge app-ui's <Icon> to the icon registry (unplugin-icons `kimi`
// collection, wired in vite.config.ts).
app.provide(IconResolverKey, (name) => getIcon(name as IconName)?.component);
app.mount('#app');

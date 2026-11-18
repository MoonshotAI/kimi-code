import { createApp } from 'vue';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import { KimiI18nKey, type KimiI18nApi } from '@moonshot-ai/app-i18n';
import { getIcon, type IconName } from '@moonshot-ai/app-client/icons';
import { installImeCompositionLatch } from '@moonshot-ai/app-client/lib';
import App from './App.vue';
import i18n from './i18n';
import { createAppRouter } from './router';
import './style.css';

document.documentElement.lang = i18n.global.locale.value === 'zh' ? 'zh-CN' : 'en';

const app = createApp(App).use(i18n).use(createAppRouter());
const kimiI18n: KimiI18nApi = {
  t: (key, params) => i18n.global.t(key, params as never),
  locale: i18n.global.locale.value,
};
app.provide(KimiI18nKey, kimiI18n);
app.provide(IconResolverKey, (name) => getIcon(name as IconName)?.component);
installImeCompositionLatch();
app.mount('#app');

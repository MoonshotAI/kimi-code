import { createApp } from 'vue';
import { createKimiI18n, KimiI18nKey, type KimiI18nApi } from '@moonshot-ai/web-i18n';
import '@moonshot-ai/web-ui/style.css';
import App from './App.vue';

// Desktop renderer entry (Task 4.4 placeholder). Mounts the Vue app, installs
// vue-i18n, and hands packages a translator via `KimiI18nKey` without forcing
// them to import the global vue-i18n. The full shell (router, daemon wiring,
// lightweight projector) lands in Task 4.5 — see ./bootstrap.ts.
const i18n = createKimiI18n({});
const kimiI18n: KimiI18nApi = {
  t: (key, params) => i18n.global.t(key, params as never),
};

createApp(App).use(i18n).provide(KimiI18nKey, kimiI18n).mount('#app');

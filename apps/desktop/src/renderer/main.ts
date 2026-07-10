import { createApp } from 'vue';
import { createKimiI18n, KimiI18nKey, type KimiI18nApi } from '@moonshot-ai/web-i18n';
import '@moonshot-ai/web-ui/style.css';
import App from './App.vue';

// Desktop renderer entry (Task 4.4 placeholder). Mounts the Vue app, installs
// vue-i18n, and hands packages a translator via `KimiI18nKey` without forcing
// them to import the global vue-i18n. The full shell (router, daemon wiring,
// lightweight projector) lands in Task 4.5 — see ./bootstrap.ts.
const i18n = createKimiI18n({});
// Wrap the composer as a minimal `KimiI18nApi` (its `locale` is a Ref, not a
// string) so `inject(KimiI18nKey)` stays type-safe — same shape as apps/web.
// The composer's overloaded `t` only cleanly takes a second argument when it is
// a named-values record, so branch on `params` rather than casting it.
const kimiI18n: KimiI18nApi = {
  t: (key, params) => (params === undefined ? i18n.global.t(key) : i18n.global.t(key, params)),
};

createApp(App).use(i18n).provide(KimiI18nKey, kimiI18n).mount('#app');

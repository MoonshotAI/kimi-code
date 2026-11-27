import { createApp } from 'vue';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { getIcon, type IconName } from '@moonshot-ai/app-ui/icons';
import '@moonshot-ai/app-ui/style.css';
import './screenshot.css';
import ScreenshotOverlay from './ScreenshotOverlay.vue';

const app = createApp(ScreenshotOverlay);
app.use(createKimiI18n({}));
app.provide(IconResolverKey, (name) => getIcon(name as IconName)?.component);
app.mount('#app');

import { createApp } from 'vue';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import { getIcon, type IconName } from '@moonshot-ai/app-client/icons';
import '@moonshot-ai/app-ui/style.css';
import './pin.css';
import PinnedScreenshot from './PinnedScreenshot.vue';

const app = createApp(PinnedScreenshot);
app.provide(IconResolverKey, (name) => getIcon(name as IconName)?.component);
app.mount('#app');

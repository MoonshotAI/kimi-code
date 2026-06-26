import { createApp } from 'vue';
import App from './App.vue';
import i18n from './i18n';
import { installClientErrorCapture } from './debug/trace';
import '@fontsource-variable/inter/wght.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import './style.css';

// Opt-in (only with ?debug=1 / the debug flag): fold front-end errors and
// console.error/warn into the trace buffer so the panel's "export jsonl" gives
// a complete troubleshooting log, not just network traffic.
installClientErrorCapture();

createApp(App).use(i18n).mount('#app');

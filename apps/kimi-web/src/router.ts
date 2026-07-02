import { defineComponent } from 'vue';
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';

// The app is mostly a single-session shell. Routing exists mainly so the
// long-press-logo easter egg can open the design system as a real,
// deep-linkable page instead of an iframe. App.vue renders the design-system
// view by matching the route name, so these routes only carry a no-op
// component (vue-router's RouterView is not used here).
const Noop = defineComponent({ render: () => null });

const routes: RouteRecordRaw[] = [
  { path: '/', name: 'home', component: Noop },
  { path: '/design-system', name: 'design-system', component: Noop },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

export default router;

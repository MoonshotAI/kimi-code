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

// The URL the user was on before opening the design system, so the Back button
// can return to the exact session/URL instead of the app root. Recorded on
// entry (not on in-page hash navigation) so section anchors don't overwrite it.
export let designSystemReturnPath: string | null = null;

router.beforeEach((to, from) => {
  if (to.name === 'design-system' && from.name !== 'design-system') {
    // The session URL is rewritten via the native history API, bypassing
    // vue-router, so read the actual browser URL instead of from.fullPath
    // (which can be stale, e.g. still '/' after a session was selected).
    const { pathname, search, hash } = window.location;
    const current = `${pathname}${search}${hash}`;
    designSystemReturnPath = current.startsWith('/design-system') ? '/' : current;
  }
});

export default router;

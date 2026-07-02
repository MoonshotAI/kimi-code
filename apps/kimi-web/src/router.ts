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

// Set by the sidebar logo entry so the Back button can return to the exact
// session/URL. Captured at the explicit entry action (rather than in a
// navigation guard) so browser Back/Forward into the design route does not
// overwrite it with the design-system URL itself.
export function setDesignSystemReturnPath(path: string): void {
  designSystemReturnPath = path;
}

export default router;

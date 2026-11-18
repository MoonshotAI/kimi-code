import {
  createRouter,
  createWebHistory,
  type LocationQuery,
  type RouteLocationRaw,
  type RouteRecordRaw,
  type Router,
} from 'vue-router';
import { parseRedirectUri } from './helpers';
import LoginPage from './LoginPage.vue';
import DevicesPage from './DevicesPage.vue';
import OfflinePage from './OfflinePage.vue';

export function guardLoginPage(to: { query: LocationQuery }): RouteLocationRaw | undefined {
  return parseRedirectUri(to.query.redirect_uri) === null ? { name: 'home' } : undefined;
}

export const routes: RouteRecordRaw[] = [
  { path: '/', name: 'home', component: DevicesPage },
  { path: '/offline', name: 'offline', component: OfflinePage },
  { path: '/login', name: 'login', component: LoginPage, beforeEnter: guardLoginPage },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

export function createAppRouter(): Router {
  return createRouter({
    history: createWebHistory(),
    routes,
  });
}

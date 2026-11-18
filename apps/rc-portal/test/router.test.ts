import { describe, expect, it } from 'vitest';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { guardLoginPage, routes } from '../src/router';

function newTestRouter(): Router {
  return createRouter({ history: createMemoryHistory(), routes });
}

describe('routes', () => {
  it('serves the devices home at /', async () => {
    const router = newTestRouter();
    await router.push('/');
    expect(router.currentRoute.value.name).toBe('home');
  });

  it('serves the offline page at /offline', async () => {
    const router = newTestRouter();
    await router.push('/offline');
    expect(router.currentRoute.value.name).toBe('offline');
  });

  it('navigates from the offline page back to home', async () => {
    const router = newTestRouter();
    await router.push('/offline');
    await router.replace({ name: 'home' });
    expect(router.currentRoute.value.name).toBe('home');
  });

  it('serves the login page at /login with a valid redirect_uri', async () => {
    const router = newTestRouter();
    await router.push(`/login?redirect_uri=${encodeURIComponent('https://rc.example.com/s/abc')}`);
    expect(router.currentRoute.value.name).toBe('login');
    expect(router.currentRoute.value.query.redirect_uri).toBe('https://rc.example.com/s/abc');
  });

  it('redirects /login to home without a redirect_uri', async () => {
    const router = newTestRouter();
    await router.push('/login');
    expect(router.currentRoute.value.name).toBe('home');
  });

  it('redirects /login to home with an invalid redirect_uri', async () => {
    const router = newTestRouter();
    await router.push(`/login?redirect_uri=${encodeURIComponent('javascript:alert(1)')}`);
    expect(router.currentRoute.value.name).toBe('home');
  });

  it('redirects unknown paths to home', async () => {
    const router = newTestRouter();
    await router.push('/no-such-page');
    expect(router.currentRoute.value.name).toBe('home');
  });
});

describe('guardLoginPage', () => {
  it('passes with a valid redirect_uri', () => {
    expect(
      guardLoginPage({ query: { redirect_uri: 'https://rc.example.com/s/abc' } }),
    ).toBeUndefined();
  });

  it('uses the first value of a repeated redirect_uri', () => {
    expect(
      guardLoginPage({
        query: { redirect_uri: ['https://rc.example.com/s/abc', 'https://evil.example.com/'] },
      }),
    ).toBeUndefined();
  });

  it('redirects to home without a valid redirect_uri', () => {
    expect(guardLoginPage({ query: {} })).toEqual({ name: 'home' });
    expect(guardLoginPage({ query: { redirect_uri: null } })).toEqual({ name: 'home' });
    expect(guardLoginPage({ query: { redirect_uri: 'not-a-url' } })).toEqual({ name: 'home' });
  });
});

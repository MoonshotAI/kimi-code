import type {
  IPluginService,
  PluginInfo,
  PluginSummary,
  PluginWebSkin,
  Scope,
} from '@moonshot-ai/agent-core-v2';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  COMMUNITY_SKINS_STYLESHEET_PATH,
  compileWebSkinTokens,
  registerWebSkinRoutes,
} from '../src/routes/webSkins';

function summary(id: string, enabled = true): PluginSummary {
  return {
    id,
    displayName: id,
    enabled,
    state: 'ok',
    skillCount: 0,
    mcpServerCount: 0,
    enabledMcpServerCount: 0,
    hookCount: 0,
    commandCount: 0,
    hasErrors: false,
    source: 'local-path',
  };
}

function info(id: string, webSkin: PluginWebSkin): PluginInfo {
  return {
    ...summary(id),
    root: id,
    installedAt: new Date(0).toISOString(),
    manifest: { name: id, webSkin },
    mcpServers: [],
    diagnostics: [],
  };
}

function coreWithPlugins(service: Pick<IPluginService, 'listPlugins' | 'getPluginInfo'>): Scope {
  return {
    accessor: { get: () => service },
  } as unknown as Scope;
}

describe('community web skins', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = Fastify();
  });

  afterEach(async () => {
    await app.close();
  });

  it('compiles light, dark, and system design tokens', () => {
    const css = compileWebSkinTokens({
      light: { '--color-bg': '#fffaf4', '--radius-lg': '18px' },
      dark: { '--color-bg': '#17121f', '--radius-lg': '18px' },
    });

    expect(css).toContain(
      ':root,html[data-color-scheme="light"]{--color-bg:#fffaf4;--radius-lg:18px}',
    );
    expect(css).toContain(
      'html[data-color-scheme="dark"]{--color-bg:#17121f;--radius-lg:18px}',
    );
    expect(css).toContain('@media (prefers-color-scheme: dark)');
  });

  it('uses locale-independent plugin-id ordering for skin precedence', async () => {
    const records = new Map([
      ['theme_1', info('theme_1', { light: { '--color-accent': '#333333' }, dark: {} })],
      ['theme0', info('theme0', { light: { '--color-accent': '#222222' }, dark: {} })],
      ['theme-1', info('theme-1', { light: { '--color-accent': '#111111' }, dark: {} })],
    ]);
    registerWebSkinRoutes(
      app,
      coreWithPlugins({
        listPlugins: async () => [summary('theme_1'), summary('theme-1'), summary('theme0')],
        getPluginInfo: async ({ id }) => records.get(id) as PluginInfo,
      }),
    );

    const response = await app.inject({ method: 'GET', url: COMMUNITY_SKINS_STYLESHEET_PATH });

    expect(response.body.indexOf('#111111')).toBeLessThan(response.body.indexOf('#222222'));
    expect(response.body.indexOf('#222222')).toBeLessThan(response.body.indexOf('#333333'));
  });

  it('serves enabled skin plugins in stable order with defensive headers', async () => {
    const records = new Map([
      [
        'alpha',
        info('alpha', { light: { '--color-accent': '#a855f7' }, dark: {} }),
      ],
      [
        'zeta',
        info('zeta', { light: { '--color-accent': '#f97316' }, dark: {} }),
      ],
    ]);
    registerWebSkinRoutes(
      app,
      coreWithPlugins({
        listPlugins: async () => [summary('zeta'), summary('disabled', false), summary('alpha')],
        getPluginInfo: async ({ id }) => records.get(id) as PluginInfo,
      }),
    );

    const response = await app.inject({ method: 'GET', url: COMMUNITY_SKINS_STYLESHEET_PATH });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/css');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(response.body.indexOf('#a855f7')).toBeLessThan(response.body.indexOf('#f97316'));
    expect(response.body).not.toContain('disabled');
  });
});

import { IPluginService, type PluginWebSkin, type Scope } from '@moonshot-ai/agent-core-v2';

export const COMMUNITY_SKINS_STYLESHEET_PATH = '/community-skins.css';

interface WebSkinRouteHost {
  get(
    path: string,
    handler: (
      req: { id: string },
      reply: {
        type(value: string): unknown;
        header(name: string, value: string): unknown;
        send(payload: unknown): unknown;
      },
    ) => unknown,
  ): unknown;
}

export function registerWebSkinRoutes(app: WebSkinRouteHost, core: Scope): void {
  app.get(COMMUNITY_SKINS_STYLESHEET_PATH, async (_req, reply) => {
    const css = await enabledWebSkinCss(core).catch(() => '');
    reply.type('text/css; charset=utf-8');
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    return reply.send(css);
  });
}

async function enabledWebSkinCss(core: Scope): Promise<string> {
  const plugins = core.accessor.get(IPluginService);
  const summaries = await plugins.listPlugins();
  const enabled = summaries
    .filter((plugin) => plugin.enabled && plugin.state === 'ok')
    .toSorted((left, right) => compareStrings(left.id, right.id));
  const compiled: string[] = [];
  for (const summary of enabled) {
    const info = await plugins.getPluginInfo({ id: summary.id }).catch(() => undefined);
    if (info?.manifest?.webSkin !== undefined) {
      compiled.push(compileWebSkinTokens(info.manifest.webSkin));
    }
  }
  return compiled.join('\n');
}

export function compileWebSkinTokens(webSkin: PluginWebSkin): string {
  const light = sortedTokens(webSkin.light);
  const dark = sortedTokens(webSkin.dark);
  return [
    tokenBlock(':root,html[data-color-scheme="light"]', light),
    tokenBlock('html[data-color-scheme="dark"]', dark),
    `@media (prefers-color-scheme: light){${tokenBlock('html[data-color-scheme="system"]', light)}}`,
    `@media (prefers-color-scheme: dark){${tokenBlock('html[data-color-scheme="system"]', dark)}}`,
  ].join('\n');
}

function sortedTokens(tokens: Readonly<Record<string, string>>): readonly (readonly [string, string])[] {
  return Object.entries(tokens).toSorted(([left], [right]) => compareStrings(left, right));
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function tokenBlock(selector: string, tokens: readonly (readonly [string, string])[]): string {
  return `${selector}{${tokens.map(([name, value]) => `${name}:${value}`).join(';')}}`;
}

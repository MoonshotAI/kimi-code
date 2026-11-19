import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModuleKind, transpileModule } from 'typescript';
import { createKimiWebApi, type KimiWebApi } from '@moonshot-ai/app-core/api';
import desktopBootstrap from '../../src/renderer/api/bootstrap.ts?raw';

const bootstraps = [{ name: 'desktop', source: desktopBootstrap }];

function loadBootstrap(rawSource: string, dev: boolean) {
  const source = rawSource.replaceAll('import.meta', 'importMeta');
  const { outputText } = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS } });
  const disposeHandlers: Array<() => void> = [];
  const createApi = vi.fn(createKimiWebApi);
  const exports = {} as { api: KimiWebApi; getKimiWebApi: () => KimiWebApi };
  const window: { __kimiApi?: KimiWebApi } = {};
  const dependencies: Record<string, unknown> = {
    '@moonshot-ai/app-core/api': { createKimiWebApi: createApi },
    '@moonshot-ai/app-core/lib': { getCredential: () => undefined, markAuthRequired: vi.fn() },
    '@moonshot-ai/app-client/trace': {
      traceRestRequest: vi.fn(), traceRestResponse: vi.fn(), traceRestFailure: vi.fn(),
      traceWsIn: vi.fn(), traceWsLifecycle: vi.fn(), traceWsOut: vi.fn(), traceKeyEvent: vi.fn(),
    },
    './config': {
      readKimiApiConfig: () => ({
        serverHttpUrl: 'http://bootstrap.test', clientId: 'test', clientName: 'test',
        clientVersion: '0', clientUiMode: 'test',
      }),
    },
  };
  const evaluate = new Function('exports', 'require', 'importMeta', 'window', outputText);
  evaluate(exports, (id: string) => {
    if (!(id in dependencies)) throw new Error(`Unexpected bootstrap dependency: ${id}`);
    return dependencies[id];
  }, {
    env: { DEV: dev },
    hot: dev ? { dispose: (callback: () => void) => disposeHandlers.push(callback) } : undefined,
  }, window);
  return { ...exports, createApi, disposeHandlers, window };
}

function envelope(data: unknown): Response {
  return new Response(JSON.stringify({ code: 0, msg: '', data }));
}

describe.each(bootstraps)('$name API bootstrap', ({ name, source }) => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps one usable production API without exposing the DEV bridge', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(envelope({ status: 'ok', uptime_sec: 5 })));
    const bootstrap = loadBootstrap(source, false);
    expect(bootstrap.createApi).toHaveBeenCalledOnce();
    expect(bootstrap.getKimiWebApi()).toBe(bootstrap.api);
    expect(bootstrap.getKimiWebApi()).toBe(bootstrap.api);
    expect(bootstrap.disposeHandlers).toHaveLength(0);
    expect(bootstrap.window.__kimiApi).toBeUndefined();
    await expect(bootstrap.api.getHealth()).resolves.toEqual({ status: 'ok', uptimeSec: 5 });
    bootstrap.api.dispose();
  });

  it('disposes the owning API on HMR and cancels queued requests without fetching them', async () => {
    const responses: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn((url: string) =>
      url.endsWith('/devices')
        ? Promise.resolve(envelope({ devices: [] }))
        : new Promise<Response>((resolve) => responses.push(resolve)));
    const sessionFetches = () => fetchMock.mock.calls.filter(([url]) => !url.endsWith('/devices')).length;
    vi.stubGlobal('fetch', fetchMock);
    const bootstrap = loadBootstrap(source, true);
    expect(bootstrap.disposeHandlers).toHaveLength(1);
    expect(bootstrap.window.__kimiApi).toBe(name === 'desktop' ? bootstrap.api : undefined);
    const first = bootstrap.api.getSessionWarnings('first');
    const second = bootstrap.api.getSessionWarnings('second');
    const queued = bootstrap.api.getSessionWarnings('queued');
    const assertion = expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => {
      expect(sessionFetches()).toBe(2);
    });

    bootstrap.disposeHandlers[0]!();
    await assertion;
    await expect(bootstrap.api.getHealth()).rejects.toMatchObject({ name: 'AbortError' });
    for (const resolve of responses) resolve(envelope({ warnings: [] }));
    await expect(Promise.all([first, second])).resolves.toEqual([[], []]);
    expect(sessionFetches()).toBe(2);
  });
});

import { describe, expect, it } from 'vitest';

import {
  DEFERRED_STARTUP_MODULES,
  checkStartupGraph,
  eagerStartupRegions,
  parseBundleRegions,
} from '../../../scripts/native/startup-graph.mjs';

const deferred = [{ name: 'the server', pattern: /\/packages\/kap-server\/src\// }];

/** A miniature rolldown bundle: wrapped modules, one lazy thunk, one static path. */
function bundle({ mainCallsRun }: { mainCallsRun: boolean }): string {
  return [
    '//#region \\0rolldown/runtime.js',
    'var __esmMin = (fn, res) => () => (fn && (res = fn(fn = 0)), res);',
    '//#endregion',
    '//#region ../../packages/kap-server/src/index.ts',
    'var server_exports = {};',
    'var init_src = __esmMin((() => {',
    '\tinit_protocol();',
    '}));',
    '//#endregion',
    '//#region ../../packages/kap-server/src/protocol.ts',
    'var init_protocol = __esmMin((() => {}));',
    '//#endregion',
    '//#region ../../node_modules/.pnpm/fastify@5.0.0/node_modules/fastify/fastify.js',
    'var require_fastify = /* @__PURE__ */ __commonJSMin(((exports, module) => {',
    '\tmodule.exports = () => {};',
    '}));',
    '//#endregion',
    '//#region src/cli/sub/web/run.ts',
    'var init_run = __esmMin((() => {',
    '\tinit_src();',
    '\t__toESM(require_fastify());',
    '}));',
    '//#endregion',
    '//#region src/cli/sub/web/lazy.ts',
    '// init_src(); inside a comment does not count',
    'var init_lazy = __esmMin((() => {}));',
    'async function load() {',
    '\tconst { startServer } = await Promise.resolve().then(() => (init_src(), server_exports));',
    '\treturn startServer;',
    '}',
    '//#endregion',
    '//#region src/main.ts',
    'init_lazy();',
    mainCallsRun ? 'init_run();' : '',
    'main();',
    '//#endregion',
  ].join('\n');
}

describe('parseBundleRegions', () => {
  it('maps every region marker to its source path and body', () => {
    const regions = parseBundleRegions(bundle({ mainCallsRun: false }));
    expect(regions.map((region) => region.path)).toEqual([
      '\\0rolldown/runtime.js',
      '../../packages/kap-server/src/index.ts',
      '../../packages/kap-server/src/protocol.ts',
      '../../node_modules/.pnpm/fastify@5.0.0/node_modules/fastify/fastify.js',
      'src/cli/sub/web/run.ts',
      'src/cli/sub/web/lazy.ts',
      'src/main.ts',
    ]);
    expect(regions.at(-1)?.body).toEqual(['init_lazy();', '', 'main();']);
  });
});

describe('eagerStartupRegions', () => {
  it('treats unwrapped regions as roots and follows eager init calls only', () => {
    const { reachable, via } = eagerStartupRegions(
      parseBundleRegions(bundle({ mainCallsRun: false })),
    );
    expect([...reachable].toSorted()).toEqual([
      '\\0rolldown/runtime.js',
      'src/cli/sub/web/lazy.ts',
      'src/main.ts',
    ]);
    expect(via.get('src/cli/sub/web/lazy.ts')).toBe('src/main.ts');
  });

  it('follows a static import chain transitively, through CommonJS wrappers too', () => {
    const { reachable, via } = eagerStartupRegions(
      parseBundleRegions(bundle({ mainCallsRun: true })),
    );
    expect(reachable.has('../../packages/kap-server/src/protocol.ts')).toBe(true);
    expect(via.get('../../packages/kap-server/src/protocol.ts')).toBe(
      '../../packages/kap-server/src/index.ts',
    );
    expect(
      via.get('../../node_modules/.pnpm/fastify@5.0.0/node_modules/fastify/fastify.js'),
    ).toBe('src/cli/sub/web/run.ts');
  });

  it('recognises the pure-annotated CommonJS wrapper as wrapped, not as a root', () => {
    const { reachable } = eagerStartupRegions(parseBundleRegions(bundle({ mainCallsRun: false })));
    expect(
      reachable.has('../../node_modules/.pnpm/fastify@5.0.0/node_modules/fastify/fastify.js'),
    ).toBe(false);
  });
});

describe('checkStartupGraph', () => {
  it('accepts a bundle that only reaches the deferred module through a lazy thunk', () => {
    expect(checkStartupGraph(bundle({ mainCallsRun: false }), { deferred })).toEqual([]);
  });

  it('reports the import chain when a deferred module is evaluated at startup', () => {
    expect(checkStartupGraph(bundle({ mainCallsRun: true }), { deferred })).toEqual([
      'the server is evaluated at startup: ../../packages/kap-server/src/index.ts <- src/cli/sub/web/run.ts <- src/main.ts',
    ]);
  });

  it('rejects a bundle without region markers instead of passing silently', () => {
    expect(checkStartupGraph('var x = 1;', { deferred })).toEqual([
      'startup graph: entry region src/main.ts not found; region markers missing?',
    ]);
  });
});

describe('DEFERRED_STARTUP_MODULES', () => {
  it('lets the tiny search worker runtime subpath through while deferring the server', () => {
    const server = DEFERRED_STARTUP_MODULES.find((m) => m.name === '@moonshot-ai/kap-server');
    expect(server?.pattern.test('../../packages/kap-server/src/search/worker/runtime.ts')).toBe(false);
    expect(server?.pattern.test('../../packages/kap-server/src/index.ts')).toBe(true);
    expect(server?.pattern.test('../../packages/kap-server/src/search/searchService.ts')).toBe(true);
  });
});

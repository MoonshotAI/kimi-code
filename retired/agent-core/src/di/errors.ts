/**
 * Errors raised by the DI subsystem.
 */

import type { Graph } from './graph';

/**
 * Thrown when the container detects a cycle in the dependency graph.
 *
 * Two construction forms are supported:
 *
 *  1. **`path: string[]` form** — used by the linear `_inProgress`
 *     tree-stack check inside `_getOrCreateInstance`. This was the only form
 *     stack check. The path is the construction stack at the moment the
 *     cycle was detected, in construction order (root → ... → repeated-id).
 *     The repeated id appears at both ends so the cycle is visually obvious.
 *
 *  2. **`Graph<any>` form** — used by the Graph-based
 *     `_createAndCacheServiceInstance`. The path is computed lazily via
 *     `graph.findCycleSlow()` when the message is built. If the cycle finder
 *     returns `undefined` we fall back to dumping the entire graph so the
 *     failure is still diagnosable.
 *
 * Both forms expose `path: ReadonlyArray<string>` so existing call sites
 * (and tests) keep working. For the Graph form the `path` array is
 * `[graph.findCycleSlow()]` split on `' -> '` so the same structural data
 * is available; this avoids forcing callers to branch on which form built
 * the error.
 */
export class CyclicDependencyError extends Error {
  readonly path: ReadonlyArray<string>;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(pathOrGraph: ReadonlyArray<string> | Graph<any>) {
    if (Array.isArray(pathOrGraph)) {
      const path = pathOrGraph as ReadonlyArray<string>;
      super(`Cyclic DI dependency detected: ${path.join(' → ')}`);
      this.path = path;
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const graph = pathOrGraph as Graph<any>;
      const cycle = graph.findCycleSlow();
      const detail = cycle ?? `UNABLE to detect cycle, dumping graph:\n${graph.toString()}`;
      super(`cyclic dependency between services: ${detail}`);
      // Provide a structured path for callers that read `.path` directly.
      // `findCycleSlow` formats as `A -> B -> A`; split it back into segments.
      this.path = cycle ? cycle.split(' -> ') : [];
    }
    this.name = 'CyclicDependencyError';
  }
}

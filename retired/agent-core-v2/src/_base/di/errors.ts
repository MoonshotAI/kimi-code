/**
 * `di` domain (L0) — `CyclicDependencyError` raised on DI dependency cycles.
 */

import type { Graph } from './graph';

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
      this.path = cycle ? cycle.split(' -> ') : [];
    }
    this.name = 'CyclicDependencyError';
  }
}

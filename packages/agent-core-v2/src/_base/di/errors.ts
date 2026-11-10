import type { Graph } from './graph';

export class CyclicDependencyError extends Error {
  readonly path: ReadonlyArray<string>;

  constructor(pathOrGraph: ReadonlyArray<string> | Graph<any>) {
    if (Array.isArray(pathOrGraph)) {
      const path = pathOrGraph as ReadonlyArray<string>;
      super(`Cyclic DI dependency detected: ${path.join(' → ')}`);
      this.path = path;
    } else {
      const graph = pathOrGraph as Graph<any>;
      const cycle = graph.findCycleSlow();
      const detail = cycle ?? `UNABLE to detect cycle, dumping graph:\n${graph.toString()}`;
      super(`cyclic dependency between services: ${detail}`);
      this.path = cycle ? cycle.split(' -> ') : [];
    }
    this.name = 'CyclicDependencyError';
  }
}

export class CascadeConflictError extends Error {
  constructor(
    readonly token: string,
    readonly detail: string,
  ) {
    super(`Cascade conflict resolving '${token}': ${detail}`);
    this.name = 'CascadeConflictError';
  }
}

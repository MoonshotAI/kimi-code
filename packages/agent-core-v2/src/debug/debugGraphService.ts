/**
 * `debug` domain — `IDebugGraphService` implementation.
 *
 * Read-only introspection over the kernel's debug accessors (`children` /
 * `servicesSnapshot` / `unitsSnapshot` / `dependencyGraph.edges`); no kernel
 * state is mutated. Bound at App scope; the injected container is the tree
 * root (the dependency graph is shared by the whole tree).
 */

import { IInstantiationService } from '#/_base/di/instantiation';
import type { InstantiationService } from '#/_base/di/instantiationService';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';

import {
  IDebugGraphService,
  type DebugGraph,
  type DebugGraphEdge,
  type DebugGraphNode,
} from './debugGraph';
import { walkScopeContainers } from './scopeTree';

export class DebugGraphService implements IDebugGraphService {
  declare readonly _serviceBrand: undefined;

  private readonly root: InstantiationService;

  constructor(@IInstantiationService instantiation: IInstantiationService) {
    this.root = instantiation as InstantiationService;
  }

  graph(): DebugGraph {
    const infos = walkScopeContainers(this.root);
    const pathByContainer = new Map<InstantiationService, string>(
      infos.map((info) => [info.container, info.path]),
    );
    const nodes = new Map<string, DebugGraphNode>();
    for (const info of infos) {
      const states = new Map(
        info.container.cascade.unitsSnapshot().map((unit) => [unit.token, unit]),
      );
      for (const registration of info.container.servicesSnapshot()) {
        const id = nodeId(info.path, registration.token);
        nodes.set(id, {
          id,
          token: registration.token,
          scopePath: info.path,
          uid: registration.uid,
          state: states.get(registration.token)?.state,
        });
      }
    }
    const pathOf = (scope: object): string =>
      pathByContainer.get(scope as InstantiationService) ??
      `#${this.root.cascadeTree.seqOf(scope)}`;
    const edges: DebugGraphEdge[] = [];
    const endpointNode = (path: string, token: string): string => {
      const id = nodeId(path, token);
      if (!nodes.has(id)) {
        nodes.set(id, { id, token, scopePath: path });
      }
      return id;
    };
    for (const edge of this.root.dependencyGraph.edges()) {
      edges.push({
        from: endpointNode(pathOf(edge.consumer.scope), edge.consumer.token.toString()),
        to: endpointNode(pathOf(edge.dependency.scope), edge.dependency.token.toString()),
        kind: edge.kind,
      });
    }
    return { nodes: [...nodes.values()], edges };
  }
}

function nodeId(scopePath: string, token: string): string {
  return `${scopePath}::${token}`;
}

registerScopedService(
  LifecycleScope.App,
  IDebugGraphService,
  DebugGraphService,
  ScopeActivation.OnDemand,
  'debug',
);

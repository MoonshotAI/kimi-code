/**
 * `debug` domain — container-tree traversal helpers shared by the debug
 * services.
 *
 * Scope paths join `debugLabel` segments from the tree root
 * (`app` / `app/workspace:<id>` / …); an unlabeled container falls back to its
 * tree sequence (`#n`). Resolution walks the live tree and compares whole
 * paths, so labels never need to be separator-safe, and a path re-resolves to
 * the same container for the process lifetime.
 */

import type { CascadeEngine } from '#/_base/di/cascadeEngine';
import type { InstantiationService } from '#/_base/di/instantiationService';

export interface ScopeContainerInfo {
  readonly container: InstantiationService;
  readonly path: string;
  readonly label: string;
}

export function scopeContainerLabel(container: InstantiationService): string {
  return container.debugLabel ?? `#${container.cascadeTree.seqOf(container)}`;
}

export function walkScopeContainers(root: InstantiationService): ScopeContainerInfo[] {
  const out: ScopeContainerInfo[] = [];
  const visit = (container: InstantiationService, path: string): void => {
    out.push({ container, path, label: scopeContainerLabel(container) });
    for (const child of container.children) {
      visit(child, `${path}/${scopeContainerLabel(child)}`);
    }
  };
  visit(root, scopeContainerLabel(root));
  return out;
}

export function resolveScopeContainer(
  root: InstantiationService,
  path: string,
): InstantiationService | undefined {
  return walkScopeContainers(root).find((info) => info.path === path)?.container;
}

export function scopePathOfEngine(
  root: InstantiationService,
  engine: CascadeEngine,
): string | undefined {
  return walkScopeContainers(root).find((info) => info.container.cascade === engine)?.path;
}

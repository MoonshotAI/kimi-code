import { NodeTreeBackend } from './tree/backend/node';
import { Trees, type TreesOptions } from './tree';

export { NodeBackend, NodeBlobBackend, NodeTreeBackend } from './tree/backend/node';

export function openTrees(dir: string, options?: TreesOptions): Promise<Trees> {
  return Trees.open(new NodeTreeBackend(`${dir}/trees`), options);
}

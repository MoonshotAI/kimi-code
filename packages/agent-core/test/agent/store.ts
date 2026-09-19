import { MemoryBackend, Trees, type Tree } from '#/store/tree';
import { treeJournal } from '#/store/journal';
import { openAgentStore, type AgentStore } from '#/stores/agent';

export async function testAgentStore(): Promise<AgentStore> {
  const backend = new MemoryBackend();
  const trees = await Trees.open(backend.trees, {});
  const tree = await trees.tree('test');
  const branch = tree.has('main') ? tree.openBranch('main') : tree.createBranch('main');
  return openAgentStore(treeJournal(tree, branch));
}

export function agentStoreFor(tree: Tree, branchName = 'main'): Promise<AgentStore> {
  return openAgentStore(treeJournal(tree, tree.openBranch(branchName)));
}

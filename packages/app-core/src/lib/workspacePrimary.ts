import type { AppWorkspace } from '../api/types';

export function isPrimaryImmutable(workspace: Pick<AppWorkspace, 'kind'>): boolean {
  return workspace.kind === 'implicit';
}

import type { Agent } from '../..';
import { isWithinDirectory } from '../../../tools/policies/path-access';
import type {
  PermissionPolicy,
  PermissionPolicyContext,
  PermissionPolicyResult,
} from '../types';
import { writeFileAccesses } from './file-access-ask';

/**
 * tower-worker agents are confined to their own worktree: TowerSpawn sets
 * the agent's cwd to the worktree, and this guard denies any Write/Edit whose
 * target escapes it — including absolute paths, which the workspace guard
 * otherwise lets through to the ask fallback. The main checkout and sibling
 * agents' slots are therefore unreachable for edits; out-of-scope changes go
 * through TowerFinding / the tower instead.
 *
 * Bash commands with absolute escape paths remain a briefing-level rule (the
 * Bash tool reports no file accesses to match against).
 */
export class TowerWorkerWriteGuardPermissionPolicy implements PermissionPolicy {
  readonly name = 'tower-worker-write-guard-deny';

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (this.agent.config?.profileName !== 'tower-worker') return;
    const toolName = context.toolCall.name;
    if (toolName !== 'Write' && toolName !== 'Edit') return;

    const cwd = this.agent.config.cwd;
    const escapes = writeFileAccesses(context).filter(
      (access) => !isWithinDirectory(access.path, cwd),
    );
    if (escapes.length === 0) return;
    return {
      kind: 'deny',
      message:
        `tower workers may only write inside their own worktree (${cwd}) — denied: ` +
        `${escapes.map((access) => access.path).join(', ')}. ` +
        'Out-of-scope changes are not yours to make: file them with TowerFinding or ask the tower via TowerSend.',
    };
  }
}

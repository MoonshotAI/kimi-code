import { IBashParserService, type BashParseResult } from '#/app/bashParser/bashParser';
import { IFlagService } from '#/app/flag/flag';
import type { PermissionPolicy, PermissionPolicyResult } from '#/agent/permissionPolicy/types';
import { IAgentProfileService } from '#/agent/profile/profile';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';

import { ARTEX_FLAG_ID } from '#/features/artex/artex';
import { IArtexModeService } from '#/features/artex/agent/artexMode';
import { ARTEX_ALL_TOOL_NAMES } from '#/features/artex/profiles/artexProfiles';
import { IArtexSessionContext } from '#/features/artex/session/artexSessionContext';
import {
  IArtexWorkStoreProvider,
  type IArtexWorkStore,
} from '#/features/artex/store/index';
import { artexSystemBlockMessage } from '#/features/artex/prompts/index';

import { isArtexAgentProfile } from './agentPredicate';
import { evaluateArtexGate } from './guard';
import { targetName } from './target';
import type { ArtexTargetRequest } from './targetGate';
import { IArtexTargetResolver } from './targetResolver';

const PARSE_OPTIONS = { timeoutMs: 500, maxNodes: 10_000 } as const;
const ARTEX_INTERNAL_APPROVE_TOOLS: ReadonlySet<string> = new Set(ARTEX_ALL_TOOL_NAMES);

/**
 * The named ARTEX permission policy. Active only when the ARTEX flag is on and the
 * agent is an ARTEX agent with an active exploration. It runs early in the chain
 * (before the auto/yolo approvers) so it can override those modes for network
 * targets. Its guarantee: a declared target no pin or exemption covers is never
 * silently approved — it is asked or denied; a target that fails to resolve is
 * denied.
 */
export class ArtexTargetGatePermissionPolicyService implements PermissionPolicy {
  readonly name = 'artex-target-gate';

  constructor(
    @IFlagService private readonly flags: IFlagService,
    @IArtexModeService private readonly mode: IArtexModeService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IArtexSessionContext private readonly session: IArtexSessionContext,
    @IArtexWorkStoreProvider private readonly provider: IArtexWorkStoreProvider,
    @IArtexTargetResolver private readonly resolver: IArtexTargetResolver,
    @IBashParserService private readonly bashParser: IBashParserService,
  ) {}

  async evaluate(
    context: ResolvedToolExecutionHookContext,
  ): Promise<PermissionPolicyResult | undefined> {
    if (!this.flags.enabled(ARTEX_FLAG_ID)) return undefined;
    const artexAgent = isArtexAgentProfile(this.profile.data().profileName) || this.mode.isActive;
    if (!artexAgent) return undefined;
    const toolName = context.toolCall.name;
    const taskId = this.session.getActiveExplorationId();
    if (taskId === undefined) {
      return ARTEX_INTERNAL_APPROVE_TOOLS.has(toolName) ? { kind: 'approve' } : undefined;
    }

    const store = this.provider.open(this.session.workspaceRoot);
    const decision = await evaluateArtexGate({
      store,
      resolver: this.resolver,
      taskId,
      toolName,
      args: context.args,
      parse: (source): BashParseResult => this.bashParser.parse(source, PARSE_OPTIONS),
      signal: context.signal,
    });

    switch (decision.kind) {
      case 'pass':
        return ARTEX_INTERNAL_APPROVE_TOOLS.has(toolName) ? { kind: 'approve' } : undefined;
      case 'deny':
        return { kind: 'deny', message: decision.message, reason: { artex_target_gate: 'block' } };
      case 'ask-rule':
        return this.askResult(decision.rule.message, [], taskId, store);
      case 'ask-target':
        return this.askResult(targetSummary(decision.requests), decision.requests, taskId, store);
      default: {
        const exhaustive: never = decision;
        return exhaustive;
      }
    }
  }

  private askResult(
    summary: string,
    requests: readonly ArtexTargetRequest[],
    taskId: number,
    store: IArtexWorkStore,
  ): PermissionPolicyResult {
    return {
      kind: 'ask',
      reason: { artex_target_gate: 'ask', targets: summary },
      resolveApproval: (response) => {
        if (response.decision !== 'approved') return undefined;
        for (const request of requests) {
          void store
            .createTargetPin({
              taskId,
              host: request.host,
              port: request.port,
              pinnedIps: request.resolvedIps,
              resolver: request.resolver,
            })
            .catch(() => undefined);
        }
        return { kind: 'approve' };
      },
      resolveNonInteractive: () => ({
        kind: 'deny',
        message: artexSystemBlockMessage(
          `a target this call reaches is not approved for this task (${summary}); no operator can approve it in a non-interactive run`,
        ),
      }),
    };
  }
}

function targetSummary(requests: readonly ArtexTargetRequest[]): string {
  return requests.map((request) => targetName(request)).join(', ');
}

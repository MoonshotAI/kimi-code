import { IBashParserService, type BashParseResult } from '#/app/bashParser/bashParser';
import { IFlagService } from '#/app/flag/flag';
import { ILogService } from '#/_base/log/log';
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

import { evaluateArtexGate } from './guard';
import type { ArtexInterceptDecision } from './interceptRules';
import { artexSafetyActive } from './artexSafetyScope';
import { IArtexTargetPinCache } from './artexTargetPinCache';
import { targetName } from './target';
import type { ArtexTargetRequest } from './targetGate';
import { IArtexTargetResolver } from './targetResolver';

const PARSE_OPTIONS = { timeoutMs: 500, maxNodes: 10_000 } as const;
const ARTEX_INTERNAL_APPROVE_TOOLS: ReadonlySet<string> = new Set(ARTEX_ALL_TOOL_NAMES);
const TARGET_PASSES_AFTER_APPROVAL = 3;

/**
 * The named ARTEX permission policy. Active only when the ARTEX flag is on and the
 * session has an active exploration (or the agent is in ARTEX mode/profile).
 */
export class ArtexTargetGatePermissionPolicyService implements PermissionPolicy {
  readonly name = 'artex-target-gate';

  private readonly pendingAskKeys = new Set<string>();

  constructor(
    @IFlagService private readonly flags: IFlagService,
    @IArtexModeService private readonly mode: IArtexModeService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IArtexSessionContext private readonly session: IArtexSessionContext,
    @IArtexWorkStoreProvider private readonly provider: IArtexWorkStoreProvider,
    @IArtexTargetResolver private readonly resolver: IArtexTargetResolver,
    @IArtexTargetPinCache private readonly pinCache: IArtexTargetPinCache,
    @IBashParserService private readonly bashParser: IBashParserService,
    @ILogService private readonly log: ILogService,
  ) {}

  async evaluate(
    context: ResolvedToolExecutionHookContext,
  ): Promise<PermissionPolicyResult | undefined> {
    if (!this.flags.enabled(ARTEX_FLAG_ID)) return undefined;
    const artexAgent = artexSafetyActive(this.profile.data().profileName, this.mode, this.session);
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
      pinCache: this.pinCache,
    });

    switch (decision.kind) {
      case 'pass':
        return ARTEX_INTERNAL_APPROVE_TOOLS.has(toolName) ? { kind: 'approve' } : undefined;
      case 'deny':
        return { kind: 'deny', message: decision.message, reason: { artex_target_gate: 'block' } };
      case 'ask-rule':
        return this.askResult(decision.rule.message, [], taskId, store, context, decision.rule);
      case 'ask-target':
        return this.askResult(targetSummary(decision.requests), decision.requests, taskId, store, context, decision.rule);
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
    context: ResolvedToolExecutionHookContext,
    rule?: ArtexInterceptDecision,
  ): PermissionPolicyResult {
    const dedupeKey =
      requests.length === 0
        ? `rule:${rule?.message ?? summary}:${String(taskId)}`
        : `${requests
            .map((request) => `${request.host}:${String(request.port)}`)
            .toSorted()
            .join('|')}:${String(taskId)}`;
    if (this.pendingAskKeys.has(dedupeKey)) {
      return {
        kind: 'ask',
        reason: { artex_target_gate: 'ask', targets: summary },
        resolveNonInteractive: () => ({
          kind: 'deny',
          message: artexSystemBlockMessage(
            `target approval for (${summary}) is already pending with the operator`,
          ),
        }),
      };
    }

    const ruleContext = rule === undefined ? '' : `\nOperator rule: ${rule.message}`;
    const fullSummary = `${summary}${ruleContext}`;

    return {
      kind: 'ask',
      reason: { artex_target_gate: 'ask', targets: fullSummary },
      resolveApproval: (response) => {
        if (response.decision !== 'approved') {
          this.pendingAskKeys.delete(dedupeKey);
          return undefined;
        }
        this.pendingAskKeys.add(dedupeKey);
        for (const request of requests) {
          this.pinCache.remember(taskId, request.host, request.port, request.resolvedIps);
          void store
            .createTargetPin({
              taskId,
              host: request.host,
              port: request.port,
              pinnedIps: request.resolvedIps,
              resolver: request.resolver,
            })
            .catch((error) => {
              const reason = error instanceof Error ? error.message : String(error);
              this.log.warn(`[artex] durable target pin failed for ${targetName(request)}: ${reason}`);
            });
        }
        void this.recheckAfterApproval(taskId, store, context)
          .catch((error) => {
            const reason = error instanceof Error ? error.message : String(error);
            this.log.warn(`[artex] post-approval target validation failed: ${reason}`);
          })
          .finally(() => {
            this.pendingAskKeys.delete(dedupeKey);
          });
        return { kind: 'approve' };
      },
      resolveNonInteractive: () => ({
        kind: 'deny',
        message: artexSystemBlockMessage(
          `a target this call reaches is not approved for this task (${fullSummary}); no operator can approve it in a non-interactive run`,
        ),
      }),
    };
  }

  private async recheckAfterApproval(
    taskId: number,
    store: IArtexWorkStore,
    context: ResolvedToolExecutionHookContext,
  ): Promise<void> {
    for (let pass = 0; pass < TARGET_PASSES_AFTER_APPROVAL; pass += 1) {
      const recheck = await evaluateArtexGate({
        store,
        resolver: this.resolver,
        taskId,
        toolName: context.toolCall.name,
        args: context.args,
        parse: (source): BashParseResult => this.bashParser.parse(source, PARSE_OPTIONS),
        signal: context.signal,
        pinCache: this.pinCache,
      });
      if (recheck.kind !== 'pass') {
        throw new Error(recheck.kind === 'deny' ? recheck.message : 'target still unpinned after approval');
      }
    }
  }
}

function targetSummary(requests: readonly ArtexTargetRequest[]): string {
  return requests.map((request) => targetName(request)).join(', ');
}
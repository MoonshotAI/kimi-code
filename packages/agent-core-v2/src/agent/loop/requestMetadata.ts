import { registerEvent2Class } from '#/app/event/event2';
import type { PromptOrigin } from '#/agent/contextMemory/types';
import type { AgentLLMRequestSource } from '#/agent/loop/requesterContract';
import { TurnStepCompleted } from '#/agent/loop/turnEvents';
import { TurnEnded, TurnPrompt } from '#/agent/loop/turnOps';
import type { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import {
  isSubagentMeta,
  subagentParentAgentId,
  subagentProfileName,
  subagentSwarmItem,
} from '#/session/agentLifecycle/subagentMetadata';
import type { AgentMeta } from '#/session/sessionMetadata/sessionMetadata';
import type { ISessionRequestAttributionService } from '#/session/requestAttribution/requestAttribution';
import type { IEventDispatcher } from '#/state/eventDispatcher';

registerEvent2Class(TurnPrompt);
registerEvent2Class(TurnEnded);

export type AgentRole =
  | 'main'
  | 'btw'
  | 'tower_worker'
  | 'swarm_member'
  | 'subagent'
  | 'other';

export type TurnTrigger =
  | 'user'
  | 'skill'
  | 'plugin_command'
  | 'subagent_task'
  | 'swarm_retry'
  | 'goal_continuation'
  | 'cron'
  | 'background_task'
  | 'tower_inbox'
  | 'shell_background'
  | 'other';

export type StepReason = 'turn_start' | 'tool_results' | 'compact';

export interface RequestMetadata {
  readonly agentRole: AgentRole;
  readonly turnTrigger?: TurnTrigger;
  readonly stepReason?: StepReason;
  readonly userInputId?: string;
  readonly parentRequestId?: string;
}

export function agentRoleOf(agentId: string, meta: AgentMeta | undefined): AgentRole {
  if (agentId === MAIN_AGENT_ID) return 'main';
  if (meta?.labels?.['btw'] === 'true') return 'btw';
  if (subagentProfileName(meta) === 'tower-worker') return 'tower_worker';
  if (subagentSwarmItem(meta) !== undefined) return 'swarm_member';
  return isSubagentMeta(meta) ? 'subagent' : 'other';
}

export function turnTriggerOf(origin: PromptOrigin | undefined): TurnTrigger {
  if (origin === undefined) return 'other';
  switch (origin.kind) {
    case 'user':
      return 'user';
    case 'skill_activation':
      return origin.trigger === 'user-slash' ? 'skill' : 'other';
    case 'plugin_command':
      return 'plugin_command';
    case 'system_trigger':
      if (origin.name === 'subagent') return 'subagent_task';
      if (origin.name === 'goal_continuation') return 'goal_continuation';
      return 'other';
    case 'retry':
      return 'swarm_retry';
    case 'cron_job':
    case 'cron_missed':
      return 'cron';
    case 'task':
      return 'background_task';
    case 'injection':
      if (origin.variant === 'tower_inbox') return 'tower_inbox';
      if (origin.variant === 'shell_command_backgrounded') return 'shell_background';
      return 'other';
    default:
      return 'other';
  }
}

export function userInputIdOf(
  origin: PromptOrigin | undefined,
  promptId: string | undefined,
): string | undefined {
  if (promptId === undefined || promptId.length === 0) return undefined;
  if (origin === undefined) return undefined;
  if (origin.kind === 'user') return promptId;
  if (origin.kind === 'skill_activation' && origin.trigger === 'user-slash') return promptId;
  if (origin.kind === 'plugin_command') return promptId;
  return undefined;
}

export function requestMetadataHeaders(metadata: RequestMetadata): Record<string, string> {
  return {
    'X-Msh-Client-Metadata': JSON.stringify({
      agent_role: metadata.agentRole,
      turn_trigger: metadata.turnTrigger,
      step_reason: metadata.stepReason,
      user_input_id: metadata.userInputId,
      parent_request_id: metadata.parentRequestId,
    }).replaceAll(
      /[\u007F-\uFFFF]/g,
      (ch) => `\\u${ch.codePointAt(0)!.toString(16).padStart(4, '0')}`,
    ),
  };
}

interface AttributionState {
  readonly userInputId?: string;
  readonly parentRequestId?: string;
  readonly activeTurn?: {
    readonly turnId: number;
    readonly turnTrigger: TurnTrigger;
    readonly stepReason: StepReason;
  };
}

export class RequestMetadataTracker {
  private state: AttributionState = {};

  constructor(
    private readonly scopeContext: IAgentScopeContext,
    dispatcher: IEventDispatcher,
    private readonly attribution?: ISessionRequestAttributionService,
  ) {
    const participant = {
      id: 'llm.requestMetadata',
      events: [TurnPrompt, TurnStepCompleted, TurnEnded],
      undoable: false,
      getState: () => this.state,
      commit: (next: AttributionState) => {
        this.state = next;
        if (next.userInputId !== undefined) {
          this.attribution?.noteUserInput(this.scopeContext.agentId, next.userInputId);
        }
        if (next.activeTurn === undefined) {
          this.attribution?.noteActiveRequest(this.scopeContext.agentId, undefined);
        }
      },
      transition: (state: AttributionState, event: unknown, ctx: { readonly silent: boolean }) => {
        if (event instanceof TurnPrompt) {
          const dispatched =
            !ctx.silent &&
            event.origin.kind === 'system_trigger' &&
            event.origin.name === 'subagent'
              ? this.attribution?.noteSubagentDispatch(
                  this.scopeContext.agentId,
                  this.parentAgentId(),
                )
              : undefined;
          return {
            userInputId:
              userInputIdOf(event.origin, event.promptId) ??
              dispatched?.userInputId ??
              state.userInputId,
            parentRequestId: dispatched?.parentRequestId ?? state.parentRequestId,
            activeTurn:
              event.turnId === undefined
                ? undefined
                : {
                    turnId: event.turnId,
                    turnTrigger: turnTriggerOf(event.origin),
                    stepReason: 'turn_start' as const,
                  },
          };
        }
        if (event instanceof TurnStepCompleted) {
          if (state.activeTurn?.turnId !== event.turnId) return state;
          if (state.activeTurn.stepReason === 'tool_results') return state;
          return {
            ...state,
            activeTurn: { ...state.activeTurn, stepReason: 'tool_results' as const },
          };
        }
        if (event instanceof TurnEnded) {
          if (state.activeTurn?.turnId !== event.turnId) return state;
          return { ...state, activeTurn: undefined };
        }
        return state;
      },
    };
    if (dispatcher.restorePhase === 'new') {
      dispatcher.attach(participant);
    } else if (dispatcher.restorePhase !== 'failed') {
      void dispatcher.attachLate(participant).catch(() => {});
    }
  }

  resolve(source: AgentLLMRequestSource | undefined): RequestMetadata {
    const agentRole = agentRoleOf(this.scopeContext.agentId, this.scopeContext.meta);
    const turn = source?.type === 'turn';
    const compact = source?.type === 'operation' && source.requestKind === 'full_compaction';
    const activeTurn = this.state.activeTurn;
    const recorded = this.attribution?.of(this.scopeContext.agentId);
    const forkedFrom = this.scopeContext.meta?.forkedFrom ?? this.scopeContext.forkedFrom;
    const forkedUserInputId =
      forkedFrom === undefined ? undefined : this.attribution?.of(forkedFrom).userInputId;
    return {
      agentRole,
      turnTrigger: turn
        ? activeTurn?.turnTrigger
        : compact
          ? (activeTurn?.turnTrigger ?? 'user')
          : undefined,
      stepReason: turn ? activeTurn?.stepReason : compact ? 'compact' : undefined,
      userInputId: this.state.userInputId ?? recorded?.userInputId ?? forkedUserInputId,
      parentRequestId:
        agentRole === 'main' || agentRole === 'btw'
          ? undefined
          : (this.state.parentRequestId ?? recorded?.parentRequestId),
    };
  }

  private parentAgentId(): string {
    const meta = this.scopeContext.meta;
    return (
      subagentParentAgentId(meta) ??
      meta?.forkedFrom ??
      this.scopeContext.forkedFrom ??
      MAIN_AGENT_ID
    );
  }
}

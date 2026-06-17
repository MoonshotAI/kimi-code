/**
 * `BridgeClientAPI` — the SDK side of the in-process RPC pair owned by
 * `CoreProcessService`. Satisfies `SDKAPI` (`@moonshot-ai/agent-core`
 * rpc/sdk-api.ts:78, via `SDKAgentAPI` at :67-72) so `KimiCore` can call
 * into it through `createRPC<CoreAPI, SDKAPI>()`. Methods route to
 * DI-resolved peer services:
 *
 *   emitEvent(event)        → IEventService.publish(event)
 *   requestApproval(req)    → IApprovalService.request(req)
 *   requestQuestion(req)    → IQuestionService.request(req)
 *   toolCall(req)           → unsupported (SDK custom tool calls not used here)
 *
 * The protocol↔in-process adapters (SCHEMAS.md §6.4 snake_case shapes, REST
 * request/response Zod validation) live at the daemon REST boundary —
 * NOT here. The peer-service interfaces stay SDK-shaped.
 */

import type { ApprovalRequest, ApprovalResponse, Event, QuestionRequest, QuestionResult, SDKAPI, ToolCallRequest, ToolCallResponse } from '../../rpc';

import type { IApprovalService } from '../approval/approval';
import type { IEventService } from '../event/event';
import type { ILogService } from '../logger/logger';
import type { IQuestionService } from '../question/question';

export interface CoreProcessClientDeps {
  readonly eventService: IEventService;
  readonly approvalService: IApprovalService;
  readonly questionService: IQuestionService;
  readonly logService: ILogService;
}

export class BridgeClientAPI implements SDKAPI {
  private readonly deps: CoreProcessClientDeps;

  constructor(deps: CoreProcessClientDeps) {
    this.deps = deps;
  }

  emitEvent(event: Event): void {
    const e = event as { type?: string; sessionId?: string; agentId?: string };
    this.deps.logService.debug(
      { type: e.type, sessionId: e.sessionId, agentId: e.agentId },
      '[DBG coreProcessClient.emitEvent]',
    );
    this.deps.eventService.publish(event);
  }

  async requestApproval(
    request: ApprovalRequest & { sessionId: string; agentId: string },
  ): Promise<ApprovalResponse> {
    return this.deps.approvalService.request(request);
  }

  async requestQuestion(
    request: QuestionRequest & { sessionId: string; agentId: string },
  ): Promise<QuestionResult> {
    return this.deps.questionService.request(request);
  }

  async toolCall(
    request: ToolCallRequest & { sessionId: string; agentId: string },
  ): Promise<ToolCallResponse> {
    // Mirrors `SDKRpcClientBase.toolCall` (packages/node-sdk/src/rpc.ts:577-582)
    // — the daemon's in-process adapter does not expose SDK-side custom tool
    // calls; the agent gets an error result it can surface upstream.
    return {
      output: `SDK custom tool calls are not supported in the daemon adapter: ${request.toolCallId}`,
      isError: true,
    };
  }
}

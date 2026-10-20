import {
  INTERACTION_TAG_TOOL_CALL_ID,
  type Interaction,
  type Interactions,
} from '#/features/interaction/index';

import {
  approvalRequestToPermissionOptions,
  attachSelectedLabel,
  buildPermissionToolCallUpdate,
  permissionResponseToApprovalResponse,
  type AcpApprovalRequestView,
  type AcpApprovalResponse,
} from './approval';
import type { AcpClient } from './client';
import { acpToolCallId, deriveToolDiffContent } from './convert';
import {
  elicitationResponseToQuestionAnswers,
  outcomeToQuestionAnswer,
  questionItemToPermissionOptions,
  questionRequestToElicitationParams,
  type AcpQuestionAnswers,
  type AcpQuestionItem,
} from './question';

export interface AcpInteractionBridgeDeps {
  readonly client: AcpClient;
  readonly sessionId: string;
  readonly interactions: () => Interactions | undefined;
  readonly elicitationForm: boolean;
  readonly currentTurnId: () => number | undefined;
  readonly readFile?: (path: string) => Promise<string | undefined>;
  readonly cwd?: () => string | undefined;
}

export interface AcpInteractionBridge {
  dispatch(item: Interaction): void;
  dispose(): void;
}

export function openAcpInteractionBridge(deps: AcpInteractionBridgeDeps): AcpInteractionBridge {
  const inFlight = new Set<string>();
  let disposed = false;

  const respond = (id: string, response: unknown): void => {
    deps.interactions()?.respond(id, response);
  };

  const handleApproval = async (item: Interaction): Promise<AcpApprovalResponse> => {
    const view = approvalViewOf(item);
    const toolCallId = wireToolCallId(item, deps.currentTurnId(), view.toolName);
    const options = approvalRequestToPermissionOptions(view);
    const diff =
      view.args === undefined
        ? null
        : await deriveToolDiffContent(view.toolName, view.args, {
            readFile: deps.readFile,
            cwd: deps.cwd,
          });
    try {
      const response = await deps.client.requestPermission({
        sessionId: deps.sessionId,
        options: [...options],
        toolCall: buildPermissionToolCallUpdate(view, toolCallId, diff),
      });
      return attachSelectedLabel(
        response,
        permissionResponseToApprovalResponse(view, response),
        options,
      );
    } catch {
      return { decision: 'rejected' };
    }
  };

  const handleQuestion = async (item: Interaction): Promise<{ answers: AcpQuestionAnswers }> => {
    const payload = item.payload as { questions?: readonly AcpQuestionItem[] };
    const questions = payload.questions ?? [];
    if (questions.length === 0) {
      return { answers: {} };
    }
    const toolCallId = wireToolCallId(item, deps.currentTurnId(), 'AskUserQuestion');
    if (deps.elicitationForm) {
      try {
        const response = await deps.client.createElicitation(
          questionRequestToElicitationParams(questions, deps.sessionId, toolCallId),
        );
        const answers = elicitationResponseToQuestionAnswers(questions, response);
        return { answers: answers ?? {} };
      } catch {
      }
    }
    const q = questions[0]!;
    const options = questionItemToPermissionOptions(q, 0);
    try {
      const response = await deps.client.requestPermission({
        sessionId: deps.sessionId,
        options: [...options],
        toolCall: {
          toolCallId,
          title: 'AskUserQuestion',
          content: [{ type: 'content', content: { type: 'text', text: q.question } }],
        },
      });
      const answers = outcomeToQuestionAnswer(q, response);
      return { answers: answers ?? {} };
    } catch {
      return { answers: {} };
    }
  };

  const settle = async (item: Interaction): Promise<void> => {
    try {
      if (item.kind === 'approval') {
        respond(item.id, await handleApproval(item));
        return;
      }
      if (item.kind === 'question') {
        respond(item.id, await handleQuestion(item));
      }
    } catch {
      respond(
        item.id,
        item.kind === 'approval'
          ? ({ decision: 'rejected' } satisfies AcpApprovalResponse)
          : { answers: {} },
      );
    }
  };

  return {
    dispatch: (item) => {
      if (disposed) return;
      if (item.kind !== 'approval' && item.kind !== 'question') return;
      if (inFlight.has(item.id)) return;
      inFlight.add(item.id);
      void settle(item);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      inFlight.clear();
    },
  };
}

function wireToolCallId(
  item: Interaction,
  currentTurnId: number | undefined,
  fallback: string,
): string {
  const raw = item.tags[INTERACTION_TAG_TOOL_CALL_ID];
  const rawId = typeof raw === 'string' && raw.length > 0 ? raw : fallback;
  return currentTurnId === undefined ? rawId : acpToolCallId(currentTurnId, rawId);
}

function approvalViewOf(item: Interaction): AcpApprovalRequestView {
  const payload = item.payload as Record<string, unknown>;
  if (typeof payload['plan'] === 'string' && typeof payload['path'] === 'string') {
    const options = Array.isArray(payload['options'])
      ? (payload['options'] as readonly { label: string; description?: string }[])
      : undefined;
    return {
      toolName: 'ExitPlanMode',
      action: 'exit plan mode',
      planReview: {
        plan: payload['plan'],
        path: payload['path'],
        options,
      },
    };
  }
  const toolName = typeof payload['toolName'] === 'string' ? payload['toolName'] : 'tool';
  const action = typeof payload['action'] === 'string' ? payload['action'] : `Approve ${toolName}`;
  const display = payload['display'] as { readonly detail?: unknown } | undefined;
  const args =
    typeof display?.detail === 'object' && display.detail !== null
      ? (display.detail as Record<string, unknown>)
      : undefined;
  return { toolName, action, planReview: undefined, args };
}

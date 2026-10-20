import type { SessionNotification } from '@agentclientprotocol/sdk';
import type { ContentPart } from '@moonshot-ai/agent-core/llm/message';
import type { HistoryMessage, ToolMeta } from '@moonshot-ai/agent-core/history/index';

import { acpToolCallId, contentPartsToAcpToolCallContent } from './convert';
import {
  textChunkToSessionUpdate,
  thoughtChunkToSessionUpdate,
  toolCallStartToSessionUpdate,
  userMessageChunkToSessionUpdate,
} from './events-map';

export function projectHistoryToSessionUpdates(
  sessionId: string,
  history: readonly HistoryMessage[],
): SessionNotification[] {
  const out: SessionNotification[] = [];
  let turnId = 0;
  const toolCallTurnIds = new Map<string, number>();

  for (const entry of history) {
    const message = entry.message;
    switch (message.role) {
      case 'user':
        for (const part of message.content) {
          if (part.type === 'text' && part.text.length > 0) {
            out.push(userMessageChunkToSessionUpdate(sessionId, part.text));
          }
        }
        break;
      case 'assistant': {
        turnId += 1;
        for (const part of message.content) {
          const update = assistantContentPartToUpdate(part, sessionId, turnId);
          if (update !== null) out.push(update);
        }
        for (const toolCall of message.toolCalls) {
          toolCallTurnIds.set(toolCall.id, turnId);
          out.push(toolCallStartToSessionUpdate(sessionId, turnId, toolCall));
        }
        break;
      }
      case 'tool': {
        const rawToolCallId = message.toolCallId;
        if (rawToolCallId.length === 0) break;
        const owningTurnId = toolCallTurnIds.get(rawToolCallId);
        if (owningTurnId === undefined) break;
        out.push({
          sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: acpToolCallId(owningTurnId, rawToolCallId),
            status: (entry.meta as ToolMeta | undefined)?.isError === true ? 'failed' : 'completed',
            content: contentPartsToAcpToolCallContent(message.content),
          },
        });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

function assistantContentPartToUpdate(
  part: ContentPart,
  sessionId: string,
  turnId: number,
): SessionNotification | null {
  void turnId;
  if (part.type === 'text' && part.text.length > 0) {
    return textChunkToSessionUpdate(sessionId, part.text);
  }
  if (part.type === 'think' && part.think.length > 0 && part.hidden !== true) {
    return thoughtChunkToSessionUpdate(sessionId, part.think);
  }
  return null;
}

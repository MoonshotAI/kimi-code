import type { SessionNotification } from '@agentclientprotocol/sdk';
import type { ContentPart, ContextMessage, ToolCall } from '@moonshot-ai/agent-core-v2';

import {
  assistantDeltaToSessionUpdate,
  thinkingDeltaToSessionUpdate,
  toolCallStartToSessionUpdate,
} from './events-map';

export function projectHistoryToSessionUpdates(
  sessionId: string,
  messages: readonly ContextMessage[],
): SessionNotification[] {
  const out: SessionNotification[] = [];
  let turnId = 0;
  const toolCallTurnIds = new Map<string, number>();

  for (const message of messages) {
    switch (message.role) {
      case 'user':
        for (const part of message.content) {
          if (part.type === 'text' && part.text) {
            out.push(userMessageChunk(sessionId, part.text));
          }
        }
        break;
      case 'assistant': {
        turnId += 1;
        for (const part of message.content) {
          const update = assistantContentPartToUpdate(part, sessionId, turnId);
          if (update !== null) out.push(update);
        }
        for (const toolCall of message.toolCalls ?? []) {
          toolCallTurnIds.set(toolCall.id, turnId);
          out.push(syntheticToolCall(sessionId, turnId, toolCall));
        }
        break;
      }
      case 'tool': {
        const update = toolMessageToUpdate(message, sessionId, toolCallTurnIds);
        if (update !== null) out.push(update);
        break;
      }
      default:
        break;
    }
  }
  return out;
}

function userMessageChunk(sessionId: string, text: string): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text },
    },
  };
}

function assistantContentPartToUpdate(
  part: ContentPart,
  sessionId: string,
  turnId: number,
): SessionNotification | null {
  if (part.type === 'text' && part.text) {
    return assistantDeltaToSessionUpdate(sessionId, {
      type: 'assistant.delta',
      turnId,
      delta: part.text,
    });
  }
  if (part.type === 'think' && part.think && part.hidden !== true) {
    return thinkingDeltaToSessionUpdate(sessionId, {
      type: 'thinking.delta',
      turnId,
      delta: part.think,
    });
  }
  return null;
}

function syntheticToolCall(
  sessionId: string,
  turnId: number,
  toolCall: ToolCall,
): SessionNotification {
  return toolCallStartToSessionUpdate(sessionId, {
    type: 'tool.call.started',
    turnId,
    toolCallId: toolCall.id,
    name: toolCall.name,
    args: parseToolCallArguments(toolCall.arguments),
  });
}

function toolMessageToUpdate(
  message: ContextMessage,
  sessionId: string,
  toolCallTurnIds: ReadonlyMap<string, number>,
): SessionNotification | null {
  const rawToolCallId = message.toolCallId;
  if (!rawToolCallId) {
    return null;
  }
  const turnId = toolCallTurnIds.get(rawToolCallId);
  if (turnId === undefined) {
    return null;
  }
  const isError = message.isError === true;
  return {
    sessionId,
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: `${turnId}:${rawToolCallId}`,
      status: isError ? 'failed' : 'completed',
      content: toolMessageContentToAcpToolCallContent(message.content),
    },
  };
}

function parseToolCallArguments(rawArguments: string | null): unknown {
  if (rawArguments === null || rawArguments === '') return {};
  try {
    return JSON.parse(rawArguments);
  } catch {
    return rawArguments;
  }
}

function toolMessageContentToAcpToolCallContent(
  parts: readonly ContentPart[],
): Array<{ type: 'content'; content: { type: 'text'; text: string } }> {
  const result: Array<{ type: 'content'; content: { type: 'text'; text: string } }> = [];
  for (const part of parts) {
    if (part.type === 'text') {
      if (part.text) {
        result.push({ type: 'content', content: { type: 'text', text: part.text } });
      }
      continue;
    }
    result.push({ type: 'content', content: { type: 'text', text: `[${part.type}]` } });
  }
  return result;
}

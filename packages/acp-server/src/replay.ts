/**
 * `session/load` history replay — projects the main agent's persisted context
 * history (`IAgentLoopService.history()`) into an ordered batch of ACP
 * `session/update` notifications so a loaded session re-renders its prior
 * turns on the client.
 *
 * Pure projection: {@link projectHistoryToSessionUpdates} maps a
 * `ContextMessage[]` to a `SessionNotification[]` with no IO, so the mapping
 * is unit-testable without a live connection. The caller (`AcpSession`)
 * awaits each push in order — replay is a one-shot batch whose completion
 * ordering is what tells `loadSession` the response is safe to return.
 *
 * Turn / tool-call correlation: agent-core-v2 persists tool calls on the
 * assistant message that issued them and tool results as separate `tool`-role
 * messages. ACP needs a single `toolCallId` to correlate the create with its
 * terminal update. Since the persisted history carries no real turn ids, the
 * replay mints a synthetic monotonically-increasing `turnId` per assistant
 * message and records `toolCallId → turnId` so the trailing `tool` messages
 * can look up the id that issued them.
 */

import type { SessionNotification } from '@agentclientprotocol/sdk';
import { isRealUserInput, type ContextMessage } from '@moonshot-ai/agent-core-v2';
import { isUserPromptSubmitHookPart } from '@moonshot-ai/agent-core-v2/agent/contextMemory/hookParts';
import type { ToolInputDisplay } from '@moonshot-ai/agent-core-v2/tool/toolInputDisplay';
import type { ContentPart, ToolCall } from '@moonshot-ai/core/llm/message';
import { stripBundledSkillBlocks } from '@moonshot-ai/core/llm/origin';

import {
  assistantDeltaToSessionUpdate,
  thinkingDeltaToSessionUpdate,
  toolCallLocations,
  toolCallStartToSessionUpdate,
} from './events-map';

export function projectHistoryToSessionUpdates(
  sessionId: string,
  messages: readonly ContextMessage[],
  cwd?: string,
): SessionNotification[] {
  const out: SessionNotification[] = [];
  let turnId = 0;
  const toolCallTurnIds = new Map<string, number>();

  for (const message of messages) {
    switch (message.role) {
      case 'user':
        for (const text of typedTexts(message)) {
          out.push(userMessageChunk(sessionId, text));
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
          out.push(syntheticToolCall(sessionId, turnId, toolCall, message.toolCallDisplays?.[toolCall.id], cwd));
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

function typedTexts(message: Extract<ContextMessage, { role: 'user' }>): string[] {
  if (!isRealUserInput(message)) return [];
  const origin = message.origin;
  if (origin?.kind === 'skill_activation') {
    const name = origin.skillSource === 'builtin' ? origin.skillName : `skill:${origin.skillName}`;
    return [slashSkillText(message.content, slashCommandText(name, origin.skillArgs))];
  }
  if (origin?.kind === 'plugin_command') {
    return [slashCommandText(`${origin.pluginId}:${origin.commandName}`, origin.commandArgs)];
  }
  return stripBundledSkillBlocks(message).flatMap((part) =>
    part.type === 'text' && part.text && !isUserPromptSubmitHookPart(part) ? [part.text] : [],
  );
}

function slashSkillText(content: readonly ContentPart[], command: string): string {
  const parts = content.filter((part) => !isUserPromptSubmitHookPart(part));
  const callerParts = parts[0]?.type === 'text' ? parts.slice(1) : parts;
  const callerText = callerParts
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('')
    .trim();
  if (callerText.length === 0) return command;
  return callerText.startsWith('/') ? callerText : `${command} ${callerText}`;
}

function slashCommandText(name: string, args: string | undefined): string {
  const trimmed = args?.trim() ?? '';
  return trimmed.length > 0 ? `/${name} ${trimmed}` : `/${name}`;
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
  display: ToolInputDisplay | undefined,
  cwd: string | undefined,
): SessionNotification {
  const args = parseToolCallArguments(toolCall.arguments);
  const notification = toolCallStartToSessionUpdate(sessionId, {
    type: 'tool.call.started',
    origin: 'loop',
    turnId,
    toolCallId: toolCall.id,
    name: toolCall.name,
    args,
    display,
  });
  if (notification.update.sessionUpdate !== 'tool_call') return notification;
  const locations = toolCallLocations(toolCall.name, args, display, cwd);
  return { ...notification, update: { ...notification.update, locations } };
}

function toolMessageToUpdate(
  message: Extract<ContextMessage, { role: 'tool' }>,
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

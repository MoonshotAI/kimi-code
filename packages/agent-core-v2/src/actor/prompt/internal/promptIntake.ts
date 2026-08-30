import { extractImageCompressionCaptions } from '#/agent/media/image-compress';
import { daemonFileRefFromPart } from '#/agent/media/mediaRef';
import { materializePromptDaemonRefs } from '#/agent/media/promptMediaIntake';
import { ISessionMediaStore } from '#/agent/media/sessionMediaStore';
import { IAgentHostService, type AgentHost } from '#/agent/host/agentHost';
import { IFileService } from '#/app/file/fileService';
import type { AgentRuntimeContext } from '#/actor/agentRuntime';
import { AgentContextMemory, type ContextMemoryRuntime } from '#/actor/contextMemory/contextMemoryAgentRuntime';
import { newMessageId } from '#/actor/contextMemory/messageId';
import { USER_PROMPT_ORIGIN, type ContextMessage } from '#/actor/contextMemory/types';
import { AgentFullCompaction } from '#/actor/fullCompaction/fullCompactionAgentRuntime';
import { getLoopControl } from '#/actor/loop/internal/access';
import type { Turn } from '#/actor/loop/internal/loop';
import { TurnSteer } from '#/actor/loop/turnOps';
import { AgentReminder, type ReminderRuntime } from '#/actor/reminder/reminderAgentRuntime';
import type { ContentPart } from '#/kosong/contract/message';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';

import { SteerStepRequest } from './promptStepRequests';

export type PromptRuntimeContext = AgentRuntimeContext<ReadonlySet<string>>;

export function hostOf(runtime: PromptRuntimeContext): AgentHost {
  return runtime.get(IAgentHostService).of(runtime.agent);
}

export function reminderOf(runtime: PromptRuntimeContext): ReminderRuntime {
  return runtime.get(IAgentLifecycleService).resolve(runtime.agent, AgentReminder);
}

export function contextMemoryOf(runtime: PromptRuntimeContext): ContextMemoryRuntime {
  return runtime.get(IAgentLifecycleService).resolve(runtime.agent, AgentContextMemory);
}

export function launchGated(runtime: PromptRuntimeContext): boolean {
  const compaction = runtime
    .get(IAgentLifecycleService)
    .resolve(runtime.agent, AgentFullCompaction);
  return compaction.status() === 'running' && getLoopControl(runtime.agent).status().state !== 'running';
}

export function extractCompressionCaptions(message: ContextMessage): {
  message: ContextMessage;
  captions: readonly string[];
} {
  if ((message.origin ?? USER_PROMPT_ORIGIN).kind !== 'user') return { message, captions: [] };
  const captions: string[] = [];
  const parts: ContentPart[] = [];
  for (const part of message.content) {
    if (part.type !== 'text') {
      parts.push(part);
      continue;
    }
    const extracted = extractImageCompressionCaptions(part.text);
    captions.push(...extracted.captions);
    if (extracted.text.trim().length > 0) parts.push({ type: 'text', text: extracted.text });
  }
  return { message: captions.length === 0 ? message : { ...message, content: parts }, captions };
}

export async function materializeDaemonRefs(
  runtime: PromptRuntimeContext,
  message: ContextMessage,
): Promise<void> {
  if (!message.content.some((part) => daemonFileRefFromPart(part) !== undefined)) return;
  const files = runtime.get(IFileService);
  const mediaStore = runtime.get(ISessionMediaStore);
  await materializePromptDaemonRefs(message.content, { files, mediaStore });
}

export function appendBlockedPrompt(
  runtime: PromptRuntimeContext,
  message: ContextMessage,
  captions: readonly string[],
): void {
  const ownerPromptId = message.id ?? newMessageId();
  for (const caption of captions) {
    reminderOf(runtime).notify(caption, {
      variant: 'image_compression',
      ownerPromptId,
    });
  }
  if (message.content.length > 0) void contextMemoryOf(runtime).append({ ...message, id: ownerPromptId });
}

export function steerRequestFor(
  runtime: PromptRuntimeContext,
  message: ContextMessage,
  captions: readonly string[],
  admission?: 'activeTurnOnly' | 'activeOrNewTurn',
): SteerStepRequest {
  return new SteerStepRequest(
    message,
    captions,
    reminderOf(runtime),
    (materialized) => {
      void hostOf(runtime).dispatcher.dispatch(
        new TurnSteer({
          agentId: runtime.agent.agentId,
          input: materialized.content,
          origin: materialized.origin ?? USER_PROMPT_ORIGIN,
        }),
      );
    },
    () => {},
    admission,
  );
}

export async function injectMessage(
  runtime: PromptRuntimeContext,
  message: ContextMessage,
): Promise<Turn | undefined> {
  const { message: rerouted, captions } = extractCompressionCaptions(message);
  await materializeDaemonRefs(runtime, rerouted);
  const request = steerRequestFor(runtime, rerouted, captions, 'activeOrNewTurn');
  return (await getLoopControl(runtime.agent).enqueue(request).assigned).turn;
}

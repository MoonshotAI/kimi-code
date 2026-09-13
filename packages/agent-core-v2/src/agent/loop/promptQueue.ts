import { USER_PROMPT_ORIGIN, type ContextMessage } from '#/agent/contextMemory/types';
import type { ContentPart } from '#human/llm/message';
import type { PromptLaunchResult, Turn } from './loop';

function bundledSkillBlockCount(message: ContextMessage): number {
  return message.origin?.kind === 'user' ? (message.origin.skillActivations?.length ?? 0) : 0;
}

export function stripBundledSkillBlocks(message: ContextMessage): ContentPart[] {
  return message.content.slice(bundledSkillBlockCount(message));
}

export function mergeSteerMessages(messages: readonly ContextMessage[]): ContextMessage {
  const skillActivations = messages.flatMap((message) =>
    message.origin?.kind === 'user' ? (message.origin.skillActivations ?? []) : [],
  );
  const attachments = messages.flatMap((message) =>
    message.origin?.kind === 'user' ? (message.origin.attachments ?? []) : [],
  );
  return {
    role: 'user',
    content: [
      ...messages.flatMap((message) => message.content.slice(0, bundledSkillBlockCount(message))),
      ...messages.flatMap((message) => stripBundledSkillBlocks(message)),
    ],
    toolCalls: [],
    origin:
      skillActivations.length === 0 && attachments.length === 0
        ? USER_PROMPT_ORIGIN
        : {
            kind: 'user',
            skillActivations: skillActivations.length === 0 ? undefined : skillActivations,
            attachments: attachments.length === 0 ? undefined : attachments,
          },
  };
}

export async function launchedTurnId(
  launched: Promise<Turn | undefined>,
): Promise<PromptLaunchResult | undefined> {
  const turn = await launched;
  if (turn === undefined) return undefined;
  await turn.ready.catch(() => undefined);
  return turn.id === undefined ? undefined : { turn_id: turn.id };
}

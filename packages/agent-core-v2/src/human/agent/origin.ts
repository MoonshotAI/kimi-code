import type { ContentPart } from '#/llm/message';

export type SkillSource = 'project' | 'user' | 'extra' | 'builtin';

export interface PromptFileAttachment {
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
  readonly path: string;
}

export interface BundledSkillActivation {
  readonly activationId: string;
  readonly skillName: string;
  readonly skillArgs?: string;
  readonly skillType?: string;
  readonly skillPath?: string;
  readonly skillSource?: SkillSource;
}

export interface UserPromptOrigin {
  readonly kind: 'user';
  readonly skillActivations?: readonly BundledSkillActivation[];
  readonly attachments?: readonly PromptFileAttachment[];
}

export const USER_PROMPT_ORIGIN: UserPromptOrigin = { kind: 'user' };

export interface PromptOrigin {
  readonly kind: string;
}

export interface SteerMessage {
  readonly content: readonly ContentPart[];
  readonly origin?: PromptOrigin;
}

function userOriginOf(origin: PromptOrigin | undefined): UserPromptOrigin | undefined {
  return origin !== undefined && origin.kind === 'user' ? (origin as UserPromptOrigin) : undefined;
}

function bundledSkillBlockCount(message: SteerMessage): number {
  return userOriginOf(message.origin)?.skillActivations?.length ?? 0;
}

export function stripBundledSkillBlocks(message: SteerMessage): ContentPart[] {
  return message.content.slice(bundledSkillBlockCount(message));
}

export function mergeSteerMessages(messages: readonly SteerMessage[]): {
  role: 'user';
  content: ContentPart[];
  toolCalls: [];
  origin: UserPromptOrigin;
} {
  const skillActivations = messages.flatMap(
    (message) => userOriginOf(message.origin)?.skillActivations ?? [],
  );
  const attachments = messages.flatMap((message) => userOriginOf(message.origin)?.attachments ?? []);
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

import { promptDisplayTextFromContentParts } from '../../agent/prompt/promptMetadataText';
import type { ContentPart, TextPart } from '#/llm/message';

export const SKILL_ACTIVATION_PART_SOURCE = 'skill activation';

export function skillActivationPart(text: string, activationId: string): TextPart {
  return { type: 'text', text, meta: { source: SKILL_ACTIVATION_PART_SOURCE, activationId } };
}

export function isSkillActivationPart(part: ContentPart): boolean {
  return part.type === 'text' && part.meta?.source === SKILL_ACTIVATION_PART_SOURCE;
}

export function annotateBundledSkillParts(
  content: readonly ContentPart[],
  bundledActivations: readonly BundledSkillActivation[],
): ContentPart[] {
  if (bundledActivations.length === 0 || content.some(isSkillActivationPart)) {
    return [...content];
  }
  let index = 0;
  return content.map((part) => {
    const activation = bundledActivations[index];
    if (activation !== undefined && part.type === 'text' && part.meta?.source === undefined) {
      index += 1;
      return {
        ...part,
        meta: { source: SKILL_ACTIVATION_PART_SOURCE, activationId: activation.activationId },
      };
    }
    return part;
  });
}

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
  readonly inTurn?: true;
  readonly clientMetadata?: readonly Readonly<Record<string, unknown>>[];
  readonly skillActivations?: readonly BundledSkillActivation[];
  readonly attachments?: readonly PromptFileAttachment[];
}

export const USER_PROMPT_ORIGIN: UserPromptOrigin = { kind: 'user' };

export interface PromptOrigin {
  readonly kind: string;
  readonly inTurn?: true;
}

export interface SteerMessage {
  readonly content: readonly ContentPart[];
  readonly origin?: PromptOrigin;
}

function userOriginOf(origin: PromptOrigin | undefined): UserPromptOrigin | undefined {
  return origin !== undefined && origin.kind === 'user' ? (origin as UserPromptOrigin) : undefined;
}

function bundledSkillActivationsOf(message: SteerMessage): readonly BundledSkillActivation[] {
  return userOriginOf(message.origin)?.skillActivations ?? [];
}

export function stripBundledSkillBlocks(message: SteerMessage): ContentPart[] {
  return annotateBundledSkillParts(message.content, bundledSkillActivationsOf(message)).filter(
    (part) => !isSkillActivationPart(part),
  );
}

export function mergeSteerMessages(messages: readonly SteerMessage[]): {
  role: 'user';
  content: ContentPart[];
  toolCalls: [];
  origin: UserPromptOrigin;
} {
  const hasClientMetadata = messages.some((message) => (userOriginOf(message.origin)?.clientMetadata?.length ?? 0) > 0);
  const clientMetadata = hasClientMetadata ? messages.flatMap((message) => {
    const metadata = userOriginOf(message.origin)?.clientMetadata;
    return metadata !== undefined && metadata.length > 0 ? metadata : [{ display_text: promptDisplayTextFromContentParts(stripBundledSkillBlocks(message)) }];
  }) : [];
  const skillActivations = messages.flatMap(
    (message) => userOriginOf(message.origin)?.skillActivations ?? [],
  );
  const attachments = messages.flatMap((message) => userOriginOf(message.origin)?.attachments ?? []);
  return {
    role: 'user',
    content: [
      ...messages.flatMap((message) =>
        annotateBundledSkillParts(message.content, bundledSkillActivationsOf(message)).filter(
          isSkillActivationPart,
        ),
      ),
      ...messages.flatMap((message) => stripBundledSkillBlocks(message)),
    ],
    toolCalls: [],
    origin:
      skillActivations.length === 0 && attachments.length === 0 && clientMetadata.length === 0
        ? USER_PROMPT_ORIGIN
        : {
            kind: 'user',
            clientMetadata: clientMetadata.length === 0 ? undefined : clientMetadata,
            skillActivations: skillActivations.length === 0 ? undefined : skillActivations,
            attachments: attachments.length === 0 ? undefined : attachments,
          },
  };
}

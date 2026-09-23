import { extractImageCompressionCaptions } from '#/llm/media/imageCaption';
import { matchSingleMediaPathTag } from '#/llm/media/pathTag';
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

function bundledSkillBlockCount(message: SteerMessage): number {
  return userOriginOf(message.origin)?.skillActivations?.length ?? 0;
}

export function stripBundledSkillBlocks(message: SteerMessage): ContentPart[] {
  return message.content.slice(bundledSkillBlockCount(message));
}

export function promptDisplayTextFromContentParts(parts: readonly ContentPart[]): string {
  const texts: string[] = [];
  for (const part of parts) {
    const text = promptPartText(part);
    if (text !== undefined) texts.push(text);
  }
  return texts.join('\n');
}

function promptPartText(part: ContentPart): string | undefined {
  switch (part.type) {
    case 'text': {
      if (matchSingleMediaPathTag(part.text) !== undefined) return undefined;
      const { text } = extractImageCompressionCaptions(part.text);
      return text.trim().length === 0 ? undefined : text;
    }
    case 'image_url':
      return '[image]';
    case 'audio_url':
      return '[audio]';
    case 'video_url':
      return '[video]';
    case 'think':
      return undefined;
  }
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
      ...messages.flatMap((message) => message.content.slice(0, bundledSkillBlockCount(message))),
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

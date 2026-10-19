import type { ContentPart, TextPart } from '#human/llm/message';

export const USER_PROMPT_SUBMIT_HOOK_SOURCE = 'user prompt submit hook';
export const USER_PROMPT_SUBMIT_HOOK_CONTENT_TYPE = 'text/xml';

export function userPromptSubmitHookPart(text: string): TextPart {
  return {
    type: 'text',
    text,
    meta: {
      contentType: USER_PROMPT_SUBMIT_HOOK_CONTENT_TYPE,
      source: USER_PROMPT_SUBMIT_HOOK_SOURCE,
    },
  };
}

export function isUserPromptSubmitHookPart(part: ContentPart): boolean {
  return part.type === 'text' && part.meta?.source === USER_PROMPT_SUBMIT_HOOK_SOURCE;
}

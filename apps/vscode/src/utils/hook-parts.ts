import type { ContentPart } from "@moonshot-ai/kimi-code-sdk";

export function isUserPromptSubmitHookPart(
  part: ContentPart,
): part is Extract<ContentPart, { type: "text" }> {
  return (
    part.type === "text" &&
    (part as { meta?: { source?: unknown } }).meta?.source === "user prompt submit hook"
  );
}

export function withoutUserPromptSubmitHookParts(
  content: readonly ContentPart[],
): ContentPart[] {
  return content.filter((part) => !isUserPromptSubmitHookPart(part));
}

export function hookResultBody(text: string): string {
  const match = /^<hook_result hook_event="[^"]*">\n([\s\S]*)\n<\/hook_result>$/.exec(text);
  return match?.[1] ?? text;
}

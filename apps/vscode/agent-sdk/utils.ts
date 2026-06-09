import type { DisplayBlock, BriefBlock, ContentPart } from "./schema";

// Display Block Helpers
export function extractBrief(display?: DisplayBlock[]): string {
  const brief = display?.find((d): d is BriefBlock => d.type === "brief");
  return brief?.text ?? "";
}

// Content Part Helpers
export function extractTextFromContentParts(parts: ContentPart[]): string {
  return parts
    .filter((p): p is ContentPart & { type: "text" } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

export function formatContentOutput(output: string | ContentPart[]): string {
  if (typeof output === "string") {
    return output;
  }

  if (!Array.isArray(output)) {
    return JSON.stringify(output);
  }

  return output
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }
      if (item.type === "text") {
        return item.text;
      }
      // Placeholder for non-text parts for debugging
      return `[${item.type}]`;
    })
    .filter(Boolean)
    .join("\n");
}

export function cleanSystemTags(text: string): string {
  return text.replace(/<(system-reminder|system)\b[^>]*>[\s\S]*?<\/\1>\s*/gi, "").trim();
}

export function cleanUserInput(input: string | ContentPart[]): string | ContentPart[] | null {
  if (typeof input === "string") {
    const text = cleanSystemTags(input);
    return text || null;
  }

  const parts = input
    .map((part) => {
      if (part.type !== "text") {
        return part;
      }

      const text = cleanSystemTags(part.text);
      return text ? { ...part, text } : null;
    })
    .filter((part): part is ContentPart => part !== null);

  return parts.length > 0 ? parts : null;
}

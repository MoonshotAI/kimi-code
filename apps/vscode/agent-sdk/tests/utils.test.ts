import { describe, it, expect } from "vitest";
import { cleanSystemTags, cleanUserInput, extractBrief, extractTextFromContentParts, formatContentOutput } from "../utils";
import type { DisplayBlock, ContentPart } from "../schema";

describe("cleanSystemTags", () => {
  it("removes system reminder blocks", () => {
    const text = "Hello\n<system-reminder>\nCurrent todo list:\n[pending] Hidden\n</system-reminder>\nWorld";
    expect(cleanSystemTags(text)).toBe("Hello\nWorld");
  });

  it("removes legacy system blocks", () => {
    expect(cleanSystemTags("<system>hidden</system>\nVisible")).toBe("Visible");
  });
});

describe("cleanUserInput", () => {
  it("returns null when text only contains system reminder content", () => {
    expect(cleanUserInput("<system-reminder>hidden</system-reminder>")).toBeNull();
  });

  it("cleans text content parts and preserves media parts", () => {
    const input: ContentPart[] = [
      { type: "text", text: "Visible\n<system-reminder>hidden</system-reminder>" },
      { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
    ];

    expect(cleanUserInput(input)).toEqual([
      { type: "text", text: "Visible" },
      { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
    ]);
  });
});

// ============================================================================
// extractBrief Tests
// ============================================================================
describe("extractBrief", () => {
  it("extracts brief text from display blocks", () => {
    const display: DisplayBlock[] = [
      { type: "diff", path: "/file.ts", old_text: "a", new_text: "b" },
      { type: "brief", text: "Modified file.ts" },
      { type: "todo", items: [{ title: "Task", status: "done" }] },
    ];
    expect(extractBrief(display)).toBe("Modified file.ts");
  });

  it("returns first brief when multiple exist", () => {
    const display: DisplayBlock[] = [
      { type: "brief", text: "First brief" },
      { type: "brief", text: "Second brief" },
    ];
    expect(extractBrief(display)).toBe("First brief");
  });

  it("returns empty string when no brief block", () => {
    const display: DisplayBlock[] = [{ type: "diff", path: "/file.ts", old_text: "a", new_text: "b" }];
    expect(extractBrief(display)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(extractBrief(undefined)).toBe("");
  });

  it("returns empty string for empty array", () => {
    expect(extractBrief([])).toBe("");
  });
});

// ============================================================================
// extractTextFromContentParts Tests
// ============================================================================
describe("extractTextFromContentParts", () => {
  it("extracts text from text parts", () => {
    const parts: ContentPart[] = [
      { type: "text", text: "Hello" },
      { type: "text", text: "World" },
    ];
    expect(extractTextFromContentParts(parts)).toBe("Hello\nWorld");
  });

  it("filters out non-text parts", () => {
    const parts: ContentPart[] = [
      { type: "text", text: "Before" },
      { type: "think", think: "thinking...", encrypted: null },
      { type: "text", text: "After" },
      { type: "image_url", image_url: { url: "data:image/png;base64,..." } },
    ];
    expect(extractTextFromContentParts(parts)).toBe("Before\nAfter");
  });

  it("returns empty string for empty array", () => {
    expect(extractTextFromContentParts([])).toBe("");
  });

  it("returns empty string when no text parts", () => {
    const parts: ContentPart[] = [
      { type: "think", think: "thinking..." },
      { type: "image_url", image_url: { url: "..." } },
    ];
    expect(extractTextFromContentParts(parts)).toBe("");
  });

  it("handles single text part", () => {
    const parts: ContentPart[] = [{ type: "text", text: "Single" }];
    expect(extractTextFromContentParts(parts)).toBe("Single");
  });
});

// ============================================================================
// formatContentOutput Tests
// ============================================================================
describe("formatContentOutput", () => {
  it("returns string as-is", () => {
    expect(formatContentOutput("Hello, World!")).toBe("Hello, World!");
  });

  it("returns empty string as-is", () => {
    expect(formatContentOutput("")).toBe("");
  });

  it("formats ContentPart array with text parts", () => {
    const parts: ContentPart[] = [
      { type: "text", text: "Line 1" },
      { type: "text", text: "Line 2" },
    ];
    expect(formatContentOutput(parts)).toBe("Line 1\nLine 2");
  });

  it("shows placeholder for non-text parts", () => {
    const parts: ContentPart[] = [
      { type: "text", text: "Before" },
      { type: "image_url", image_url: { url: "..." } },
      { type: "text", text: "After" },
    ];
    expect(formatContentOutput(parts)).toBe("Before\n[image_url]\nAfter");
  });

  it("handles think parts", () => {
    const parts: ContentPart[] = [
      { type: "think", think: "reasoning..." },
      { type: "text", text: "Result" },
    ];
    expect(formatContentOutput(parts)).toBe("[think]\nResult");
  });

  it("handles audio_url parts", () => {
    const parts: ContentPart[] = [{ type: "audio_url", audio_url: { url: "data:audio/aac;base64,..." } }];
    expect(formatContentOutput(parts)).toBe("[audio_url]");
  });

  it("handles video_url parts", () => {
    const parts: ContentPart[] = [{ type: "video_url", video_url: { url: "data:video/mp4;base64,..." } }];
    expect(formatContentOutput(parts)).toBe("[video_url]");
  });

  it("handles empty array", () => {
    expect(formatContentOutput([])).toBe("");
  });

  it("handles mixed array with strings (edge case)", () => {
    // This tests the internal string handling in the array case
    const parts = ["raw string" as unknown as ContentPart];
    expect(formatContentOutput(parts)).toBe("raw string");
  });

  it("stringifies non-array non-string input", () => {
    // Edge case: input is neither string nor array
    const obj = { foo: "bar" } as unknown as string | ContentPart[];
    expect(formatContentOutput(obj)).toBe('{"foo":"bar"}');
  });
});

import type { ContentPart } from "@moonshot-ai/kimi-code-vscode-agent-sdk/schema";
import { cleanSystemTags } from "shared/utils";
import { getMediaTypeFromDataUri } from "./media-utils";

export const Content = {
  getText(input: string | ContentPart[] | null | undefined): string {
    if (typeof input === "string") {
      return cleanSystemTags(input);
    }
    if (!Array.isArray(input)) {
      return "";
    }
    const texts = input.filter((p): p is ContentPart & { type: "text" } => p?.type === "text").map((p) => p.text);
    return cleanSystemTags(texts.join("\n"));
  },

  getImages(input: string | ContentPart[] | null | undefined): string[] {
    if (typeof input === "string" || !Array.isArray(input)) {
      return [];
    }
    return input.filter((p): p is ContentPart & { type: "image_url" } => p?.type === "image_url").map((p) => p.image_url.url);
  },

  getVideos(input: string | ContentPart[] | null | undefined): string[] {
    if (typeof input === "string" || !Array.isArray(input)) {
      return [];
    }
    return input.filter((p): p is ContentPart & { type: "video_url" } => p?.type === "video_url").map((p) => p.video_url.url);
  },

  hasImages(input: string | ContentPart[]): boolean {
    return Content.getImages(input).length > 0;
  },

  hasVideos(input: string | ContentPart[]): boolean {
    return Content.getVideos(input).length > 0;
  },

  hasMedia(input: string | ContentPart[]): boolean {
    return Content.hasImages(input) || Content.hasVideos(input);
  },

  build(text: string, mediaUrls: string[]): ContentPart[] {
    const parts: ContentPart[] = [];
    if (text.trim()) {
      parts.push({ type: "text", text });
    }
    for (const url of mediaUrls) {
      const mediaType = getMediaTypeFromDataUri(url);
      if (mediaType === "video") {
        parts.push({ type: "video_url", video_url: { url } });
      } else {
        parts.push({ type: "image_url", image_url: { url } });
      }
    }
    return parts;
  },

  isEmpty(input: string | ContentPart[]): boolean {
    return !Content.getText(input).trim() && !Content.hasMedia(input);
  },
};

import type { ContentPart } from "shared/legacy-sdk";
import { cleanSystemTags } from "shared/utils";
import { getMediaTypeFromDataUri } from "./media-utils";

export const Content = {
  getText(input: string | ContentPart[]): string {
    if (typeof input === "string") {
      return cleanSystemTags(input);
    }
    const texts = input.filter((p): p is ContentPart & { type: "text" } => p.type === "text").map((p) => p.text);
    return cleanSystemTags(texts.join("\n"));
  },

  getImages(input: string | ContentPart[]): string[] {
    if (typeof input === "string") {
      return [];
    }
    return input.filter((p): p is ContentPart & { type: "image_url" } => p.type === "image_url").map((p) => p.image_url.url);
  },

  getVideos(input: string | ContentPart[]): string[] {
    if (typeof input === "string") {
      return [];
    }
    return input.filter((p): p is ContentPart & { type: "video_url" } => p.type === "video_url").map((p) => p.video_url.url);
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

  getMediaRequirements(input: string | ContentPart[]): { image: boolean; video: boolean } {
    return { image: Content.hasImages(input), video: Content.hasVideos(input) };
  },

  build(text: string, media: readonly { id: string; dataUri: string }[]): ContentPart[] {
    const parts: ContentPart[] = [];
    if (text.trim()) {
      parts.push({ type: "text", text });
    }
    for (const { id, dataUri: url } of media) {
      const mediaType = getMediaTypeFromDataUri(url);
      if (mediaType === "video") {
        parts.push({ type: "video_url", video_url: { url, id } });
      } else {
        parts.push({ type: "image_url", image_url: { url, id } });
      }
    }
    return parts;
  },

  isEmpty(input: string | ContentPart[]): boolean {
    return !Content.getText(input).trim() && !Content.hasMedia(input);
  },
};

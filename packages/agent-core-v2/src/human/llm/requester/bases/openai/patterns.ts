import type { ContentPart, Message, ThinkPart, ToolMessage, UserMessage } from '#/llm/message';
import type { Pattern } from '#/llm/protocol/rewrite';

export const TOOL_RESULT_MEDIA_PROMPT = 'Attached media from tool result:';
export const TOOL_RESULT_MEDIA_PLACEHOLDER = '(see attached media)';

function isExtractableMedia(part: ContentPart): boolean {
  if (part.type === 'image_url') return true;
  return part.type === 'video_url' && !part.videoUrl.url.startsWith('data:');
}

export const extractToolMedia: Pattern<Message> = {
  name: 'extractToolMedia',
  rewrite(items, index) {
    const first = items[index];
    if (first === undefined || first.role !== 'tool') return null;
    let end = index;
    while (end < items.length && items[end]?.role === 'tool') {
      end += 1;
    }
    const run = items.slice(index, end) as ToolMessage[];
    const media: ContentPart[] = [];
    for (const message of run) {
      for (const part of message.content) {
        if (isExtractableMedia(part)) {
          media.push(part);
        }
      }
    }
    if (media.length === 0) return null;
    const stripped = run.map((message) => {
      const content = message.content.filter((part) => !isExtractableMedia(part));
      const hadImage = message.content.some((part) => part.type === 'image_url');
      const hasText = content.some((part) => part.type === 'text' && part.text.length > 0);
      const hasAudio = content.some((part) => part.type === 'audio_url');
      const hasDataVideo = content.some((part) => part.type === 'video_url');
      if (!hasText && !hasAudio && !hasDataVideo && hadImage) {
        return {
          ...message,
          content: [
            { type: 'text', text: TOOL_RESULT_MEDIA_PLACEHOLDER } as ContentPart,
            ...message.content.filter((part): part is ThinkPart => part.type === 'think'),
          ],
        };
      }
      if (content.length === message.content.length) return message;
      return { ...message, content };
    });
    const mediaUser: UserMessage = {
      role: 'user',
      content: [{ type: 'text', text: TOOL_RESULT_MEDIA_PROMPT }, ...media],
    };
    return { consumed: run.length, replacement: [...stripped, mediaUser] };
  },
};

import { extractText, type Message } from '#/llm/message';

const OMITTED_IMAGE_PLACEHOLDER = '(image omitted: tool result converted to plain text)';
const OMITTED_AUDIO_PLACEHOLDER = '(audio omitted: tool result converted to plain text)';
const OMITTED_VIDEO_PLACEHOLDER = '(video omitted: tool result converted to plain text)';

export function convertToolResultToPlainText(message: Message): string {
  const lines: string[] = [];
  const text = extractText(message);
  if (text.length > 0) {
    lines.push(text);
  }
  if (message.content.some((part) => part.type === 'image_url')) {
    lines.push(OMITTED_IMAGE_PLACEHOLDER);
  }
  if (message.content.some((part) => part.type === 'audio_url')) {
    lines.push(OMITTED_AUDIO_PLACEHOLDER);
  }
  if (message.content.some((part) => part.type === 'video_url')) {
    lines.push(OMITTED_VIDEO_PLACEHOLDER);
  }
  return lines.join('\n');
}

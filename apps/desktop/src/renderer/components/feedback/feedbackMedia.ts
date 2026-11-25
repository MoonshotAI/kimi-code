export const FEEDBACK_MEDIA_LIMIT = 5;

export interface FeedbackMedia {
  kind: 'image' | 'video';
  file: File;
  url: string;
}

export function addFeedbackMedia(items: FeedbackMedia[], files: FileList): string[] {
  const errors = new Set<string>();
  for (const file of files) {
    const kind = file.type.split('/')[0];
    if (kind !== 'image' && kind !== 'video') {
      errors.add('feedback.mediaType');
    } else if (file.size === 0) {
      errors.add('feedback.emptyMedia');
    } else if (items.length >= FEEDBACK_MEDIA_LIMIT) {
      errors.add('feedback.mediaCount');
    } else if (kind === 'video' && items.some(item => item.kind === 'video')) {
      errors.add('feedback.videoCount');
    } else if (file.size > (kind === 'image' ? 10 : 100) * 1024 * 1024) {
      errors.add(kind === 'image' ? 'feedback.imageSize' : 'feedback.videoSize');
    } else {
      items.push({ kind, file, url: URL.createObjectURL(file) });
    }
  }
  return [...errors];
}

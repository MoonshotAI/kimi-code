import { classifyMentionHref, mentionActionLine, mentionActionPath, mentionActionSuffix, unescapeLinkDest } from '@moonshot-ai/app-composer/model';

export type StreamingLinkAction =
  | { type: 'open-file'; path: string; line?: number; urlSuffix?: string }
  | { type: 'open-external'; url: string }
  | { type: 'passthrough' }
  | { type: 'swallow' };

export function streamingLinkAction(href: string, canOpenFile: boolean): StreamingLinkAction {
  if (href.startsWith('#')) return { type: 'passthrough' };

  const kind = classifyMentionHref(href);
  if (kind !== null) {
    if (kind === 'file' && canOpenFile) {
      const line = mentionActionLine(href);
      const urlSuffix = mentionActionSuffix(href);
      return { type: 'open-file', path: unescapeLinkDest(mentionActionPath(href), false), ...(line === undefined ? {} : { line }), ...(urlSuffix === '' ? {} : { urlSuffix }) };
    }
    return { type: 'swallow' };
  }

  if (/^https?:\/\//i.test(href)) return { type: 'open-external', url: href };

  return { type: 'swallow' };
}

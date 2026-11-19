import { describe, expect, it } from 'vitest';

import { collectTurnAttachmentImages, collectTurnImages } from '../src/client/collectTurnImages';
import type { ChatTurn } from '../src/client/types';

function turn(tools: ChatTurn['tools']): ChatTurn {
  return { id: `t-${Math.random()}`, role: 'assistant', no: 1, text: '', tools };
}

describe('collectTurnImages', () => {
  it('collects image media in turn order, skipping videos and empty turns', () => {
    const a = { kind: 'image' as const, url: 'https://x/a.png', path: '/tmp/a.png' };
    const v = { kind: 'video' as const, url: 'https://x/v.mp4' };
    const b = { kind: 'image' as const, url: 'https://x/b.png' };
    const turns = [
      turn([{ id: '1', name: 'ReadMediaFile', arg: '', status: 'ok', media: a }]),
      turn(undefined),
      turn([
        { id: '2', name: 'ReadMediaFile', arg: '', status: 'ok', media: v },
        { id: '3', name: 'ReadMediaFile', arg: '', status: 'ok', media: b },
      ]),
    ];
    expect(collectTurnImages(turns)).toEqual([a, b]);
  });

  it('returns an empty list when nothing has media', () => {
    expect(collectTurnImages([])).toEqual([]);
    expect(collectTurnImages([turn([{ id: '1', name: 'Bash', arg: '', status: 'ok' }])])).toEqual([]);
  });
});

describe('collectTurnAttachmentImages', () => {
  it('maps image attachments to media with display names, skipping files and videos', () => {
    const turns = [
      {
        id: 'u1',
        role: 'user' as const,
        no: 1,
        text: '',
        attachments: [
          { kind: 'image' as const, url: 'blob:a', name: 'a.png', fileId: 'f1', sessionId: 's1', mediaType: 'image/png', size: 10 },
          { kind: 'video' as const, url: 'blob:v', name: 'v.mp4' },
          { kind: 'file' as const, url: 'blob:f', name: 'f.zip' },
        ],
      },
    ];
    expect(collectTurnAttachmentImages(turns)).toEqual([
      { kind: 'image', url: 'blob:a', name: 'a.png', fileId: 'f1', sessionId: 's1', mimeType: 'image/png', bytes: 10 },
    ]);
  });
});

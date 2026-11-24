// @vitest-environment jsdom
import { createApp, h } from 'vue';
import { describe, expect, it } from 'vitest';
import type { TurnAttachment } from '@moonshot-ai/app-core/client/types';
import ComposerText from '../../src/transcript/ComposerText.vue';
import type { ComposerDocumentSnapshot } from '../../src/model/snapshot';

const attachments: TurnAttachment[] = [
  { kind: 'image', url: '/sessions/s_1/media/f_image', fileId: 'f_image', sessionId: 's_1', mediaType: 'image/png' },
  { kind: 'video', url: '/sessions/s_1/media/f_video', fileId: 'f_video', sessionId: 's_1', mediaType: 'video/mp4' },
];

const snapshot: ComposerDocumentSnapshot = {
  version: 1,
  doc: {
    type: 'doc',
    content: [{
      type: 'paragraph',
      content: [
        { type: 'attachment', attrs: { attId: 'm1', kind: 'image', name: 'shot.png' } },
        { type: 'attachment', attrs: { attId: 'm2', kind: 'video', name: 'demo.mp4' } },
      ],
    }],
  },
  attachments: [],
  attachmentOrder: ['m1', 'm2'],
};

function renderPills(interactive?: boolean): HTMLElement[] {
  const host = document.createElement('div');
  document.body.append(host);
  const app = createApp({
    render: () => h(ComposerText, {
      text: '',
      snapshot,
      attachments,
      ...(interactive === undefined ? {} : { interactive }),
    }),
  });
  app.mount(host);
  const pills = Array.from(host.querySelectorAll<HTMLElement>('.attachment-pill'));
  app.unmount();
  host.remove();
  return pills;
}

describe.each([
  { state: 'sent', interactive: undefined, role: 'button', tabindex: '0' },
  { state: 'queued', interactive: false, role: null, tabindex: null },
])('attachment pills in $state messages', ({ interactive, role, tabindex }) => {
  it('keeps image and video preview metadata while preserving the interaction mode', () => {
    const pills = renderPills(interactive);
    expect(pills).toHaveLength(2);
    for (const [index, pill] of pills.entries()) {
      const target = attachments[index]!;
      expect(pill.dataset.attachmentKind).toBe(target.kind);
      expect(pill.dataset.attachmentUrl).toBe(target.url);
      expect(pill.dataset.attachmentFileId).toBe(target.fileId);
      expect(pill.dataset.attachmentSessionId).toBe(target.sessionId);
      expect(pill.getAttribute('role')).toBe(role);
      expect(pill.getAttribute('tabindex')).toBe(tabindex);
    }
  });
});

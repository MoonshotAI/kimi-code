import { describe, expect, it } from 'vitest';
import { attachmentTargetAttrs, attachmentTargetFor } from '../../../src/features/attachment/target';

type Att = { kind: string; name: string };
const file = (name: string): Att => ({ kind: 'file', name });
const image = (name: string): Att => ({ kind: 'image', name });

describe('attachmentTargetFor', () => {
  it('maps the 1-based index onto the message file attachments in order', () => {
    const atts = [file('a.txt'), file('b.txt'), file('c.txt')];
    expect(attachmentTargetFor('1', atts)?.name).toBe('a.txt');
    expect(attachmentTargetFor('2', atts)?.name).toBe('b.txt');
    expect(attachmentTargetFor('3', atts)?.name).toBe('c.txt');
  });

  it('counts only file attachments — media never consume an index', () => {
    const atts = [file('a.txt'), image('shot.png'), file('b.txt')];
    expect(attachmentTargetFor('1', atts)?.name).toBe('a.txt');
    expect(attachmentTargetFor('2', atts)?.name).toBe('b.txt');
    expect(attachmentTargetFor('3', atts)).toBeUndefined();
  });

  it('returns undefined for an index past the file count', () => {
    expect(attachmentTargetFor('2', [file('a.txt')])).toBeUndefined();
    expect(attachmentTargetFor('1', [])).toBeUndefined();
    expect(attachmentTargetFor('1', [image('shot.png')])).toBeUndefined();
  });

  it('returns undefined without an attachment list', () => {
    expect(attachmentTargetFor('1', undefined)).toBeUndefined();
  });

  it('rejects non-index attIds (composer-private ids must not alias an index)', () => {
    const atts = [file('a.txt')];
    expect(attachmentTargetFor('abc12345', atts)).toBeUndefined();
    expect(attachmentTargetFor('x1', atts)).toBeUndefined();
    expect(attachmentTargetFor('1x', atts)).toBeUndefined();
    expect(attachmentTargetFor('', atts)).toBeUndefined();
    expect(attachmentTargetFor('0', atts)).toBeUndefined();
    expect(attachmentTargetFor('01', atts)).toBeUndefined();
    expect(attachmentTargetFor('-1', atts)).toBeUndefined();
    expect(attachmentTargetFor('1.0', atts)).toBeUndefined();
  });

  it('handles large indexes without falling over', () => {
    const atts = Array.from({ length: 12 }, (_, i) => file(`f${i + 1}.txt`));
    expect(attachmentTargetFor('12', atts)?.name).toBe('f12.txt');
    expect(attachmentTargetFor('13', atts)).toBeUndefined();
  });

  it('maps an m-prefixed index onto the message MEDIA parts in order (files never consume one)', () => {
    const atts = [file('a.txt'), image('shot.png'), image('b.png'), file('b.txt'), { kind: 'video', name: 'demo.mp4' }];
    expect(attachmentTargetFor('m1', atts)?.name).toBe('shot.png');
    expect(attachmentTargetFor('m2', atts)?.name).toBe('b.png');
    expect(attachmentTargetFor('m3', atts)?.name).toBe('demo.mp4');
    expect(attachmentTargetFor('m4', atts)).toBeUndefined();
    expect(attachmentTargetFor('1', [image('shot.png')])).toBeUndefined();
    expect(attachmentTargetFor('m1', [file('a.txt')])).toBeUndefined();
    expect(attachmentTargetFor('m0', atts)).toBeUndefined();
    expect(attachmentTargetFor('mx', atts)).toBeUndefined();
  });
});

describe('attachmentTargetAttrs (the message-side pill’s data attributes)', () => {
  type Target = { kind: string; url: string; fileId?: string; mediaType?: string; size?: number };
  const uploaded: Target = { kind: 'file', url: '/files/f_a', fileId: 'f_a', mediaType: 'application/pdf', size: 4096 };
  const base64: Target = { kind: 'file', url: '', size: 12 };

  it('stamps metadata (incl. size) and the open affordance for an openable pill', () => {
    expect(attachmentTargetAttrs('1', [uploaded])).toEqual({
      'data-attachment-kind': 'file',
      'data-attachment-url': '/files/f_a',
      'data-attachment-file-id': 'f_a',
      'data-attachment-media-type': 'application/pdf',
      'data-attachment-size': 4096,
      tabindex: 0,
      role: 'button',
    });
  });

  it('stamps the resolved kind and session id for a media pill (the lightbox routes on them)', () => {
    const media: Target & { sessionId?: string } = { kind: 'image', url: '/sessions/s_1/media/f_img', fileId: 'f_img', mediaType: 'image/png', size: 99, sessionId: 's_1' };
    expect(attachmentTargetAttrs('m1', [media])).toEqual({
      'data-attachment-kind': 'image',
      'data-attachment-url': '/sessions/s_1/media/f_img',
      'data-attachment-file-id': 'f_img',
      'data-attachment-media-type': 'image/png',
      'data-attachment-size': 99,
      'data-attachment-session-id': 's_1',
      tabindex: 0,
      role: 'button',
    });
  });

  it('keeps the metadata on an url-less (inline-base64) pill but stays inert — the size still reaches the tooltip', () => {
    const attrs = attachmentTargetAttrs('1', [base64]);
    expect(attrs['data-attachment-size']).toBe(12);
    expect(attrs['data-attachment-url']).toBeUndefined();
    expect(attrs.tabindex).toBeUndefined();
    expect(attrs.role).toBeUndefined();
  });

  it('stamps nothing when the index does not resolve', () => {
    expect(attachmentTargetAttrs('9', [uploaded])).toEqual({});
    expect(attachmentTargetAttrs('abc12345', [uploaded])).toEqual({});
    expect(attachmentTargetAttrs('1', undefined)).toEqual({});
  });
});

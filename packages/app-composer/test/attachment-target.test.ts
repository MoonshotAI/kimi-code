import { describe, expect, it } from 'vitest';
import { attachmentTargetAttrs, attachmentTargetFor } from '../src/attachmentTarget';

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
    // Submit payload order is files first, media after; the recovered list can
    // interleave differently, but the pill index only ever addresses files.
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
});

describe('attachmentTargetAttrs (the message-side pill’s data attributes)', () => {
  type Target = { kind: string; url: string; fileId?: string; mediaType?: string; size?: number };
  const uploaded: Target = { kind: 'file', url: '/files/f_a', fileId: 'f_a', mediaType: 'application/pdf', size: 4096 };
  const base64: Target = { kind: 'file', url: '', size: 12 };

  it('stamps metadata (incl. size) and the open affordance for an openable pill', () => {
    expect(attachmentTargetAttrs('1', [uploaded])).toEqual({
      'data-attachment-url': '/files/f_a',
      'data-attachment-file-id': 'f_a',
      'data-attachment-media-type': 'application/pdf',
      'data-attachment-size': 4096,
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

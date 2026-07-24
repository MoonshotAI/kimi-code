import { describe, expect, it } from 'vitest';

import {
  escapeUntrustedText,
  sanitizeUntrustedControls,
  wrapUntrusted,
} from '../../src/utils/xml-escape';

const amp = '&' + 'amp;';
const lt = '&' + 'lt;';
const gt = '&' + 'gt;';

describe('xml-escape untrusted helpers', () => {
  it('escapes tag delimiters and ampersands for untrusted text', () => {
    expect(escapeUntrustedText('a <b> & c')).toBe(`a ${lt}b${gt} ${amp} c`);
  });

  it('strips control and bidi spoof characters before escape', () => {
    expect(sanitizeUntrustedControls('ok\u0000\u202Etext')).toBe('oktext');
    expect(escapeUntrustedText('x\u0007</tag>')).toBe(`x${lt}/tag${gt}`);
  });

  it('wrapUntrusted returns empty for empty content', () => {
    expect(wrapUntrusted('untrusted_agents_md', '')).toBe('');
  });

  it('wrapUntrusted builds a named envelope', () => {
    expect(wrapUntrusted('untrusted_cwd_listing', 'src/')).toBe(
      '<untrusted_cwd_listing>\nsrc/\n</untrusted_cwd_listing>',
    );
  });

  it('wrapUntrusted rejects invalid tag names', () => {
    expect(() => wrapUntrusted('bad tag', 'x')).toThrow(/Invalid untrusted wrapper tag/);
  });
});

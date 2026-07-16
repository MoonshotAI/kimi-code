import { describe, expect, it } from 'vitest';

import { mediaUrlPartToText, summarizeDataUrl } from '#/tui/utils/media-url';

describe('mediaUrlPartToText', () => {
  it('keeps non-data URLs as escaped XML-like references', () => {
    expect(mediaUrlPartToText('image', 'file:///tmp/a&b".png')).toBe(
      '<image url="file:///tmp/a&amp;b&quot;.png">',
    );
  });

  it('summarizes base64 data URLs without returning the payload', () => {
    expect(mediaUrlPartToText('image', 'data:image/png;base64,qrs=')).toBe(
      '[image image/png, 2 B]',
    );
  });

  it('formats larger base64 payload sizes compactly', () => {
    const oneKib = 'A'.repeat(1368);
    expect(mediaUrlPartToText('video', `data:video/mp4;base64,${oneKib}`)).toBe(
      '[video video/mp4, 1.0 KB]',
    );
  });

  it('handles unknown MIME types gracefully', () => {
    expect(mediaUrlPartToText('image', 'data:application/octet-stream;base64,AA==')).toBe(
      '[image application/octet-stream, 1 B]',
    );
  });

  it('handles empty base64 payload', () => {
    expect(mediaUrlPartToText('image', 'data:image/png;base64,')).toBe(
      '[image image/png, 0 B]',
    );
  });

  it('handles very large payload sizes with MB formatting', () => {
    const tenMb = 'A'.repeat(14_000_000);
    const result = mediaUrlPartToText('audio', `data:audio/wav;base64,${tenMb}`);
    expect(result).toMatch(/\[audio audio\/wav, [\d.]+ MB\]/);
  });

  it('escapes special characters in non-data URLs', () => {
    expect(mediaUrlPartToText('image', 'file:///tmp/a<b>c&d\'.png')).toBe(
      '<image url="file:///tmp/a&lt;b&gt;c&amp;d&apos;.png">',
    );
  });
});

describe('summarizeDataUrl', () => {
  it('returns undefined for regular URLs', () => {
    expect(summarizeDataUrl('https://example.com/a.png')).toBeUndefined();
  });

  it('parses MIME and decoded byte count for base64 data URLs', () => {
    expect(summarizeDataUrl('data:image/png;base64,AQIDBA==')).toEqual({
      mime: 'image/png',
      bytes: 4,
    });
  });

  it('returns undefined for empty data URL', () => {
    expect(summarizeDataUrl('data:')).toBeUndefined();
  });

  it('returns undefined for data URL without base64', () => {
    expect(summarizeDataUrl('data:text/plain,hello')).toBeUndefined();
  });
});

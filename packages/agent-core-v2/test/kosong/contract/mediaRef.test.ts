/**
 * `kosong/contract` mediaRef — media classification, daemon file references,
 * and media path tags.
 *
 *   - suffix / MIME / content-part classification (`mediaKindFor*` /
 *     `mediaKindOfPart`)
 *   - `kimi-file://` daemon file URL build/parse round-trips
 *   - `<image|video|file path="…">` tag emission and matching, including the
 *     legacy no-closing-tag and extra-attribute shapes
 */

import { describe, expect, it } from 'vitest';

import type { ContentPart } from '#/kosong/contract/message';
import {
  IMAGE_MIME_BY_SUFFIX,
  VIDEO_MIME_BY_SUFFIX,
  buildDaemonFileUrl,
  buildMediaPathTag,
  daemonFileRefFromPart,
  isDaemonFileUrl,
  matchMediaPathTags,
  mediaKindForMime,
  mediaKindForPath,
  mediaKindOfPart,
  parseDaemonFileUrl,
} from '#/kosong/contract/mediaRef';

describe('media kind classification', () => {
  it('classifies paths by suffix, case-insensitively', () => {
    expect(mediaKindForPath('/a/b/shot.PNG')).toBe('image');
    expect(mediaKindForPath('clip.mp4')).toBe('video');
    expect(mediaKindForPath('/a.b/clip')).toBeUndefined();
    expect(mediaKindForPath('/a/shot.')).toBeUndefined();
    expect(mediaKindForPath('notes.txt')).toBeUndefined();
  });

  it('classifies MIME types, ignoring case and parameters', () => {
    expect(mediaKindForMime('image/png')).toBe('image');
    expect(mediaKindForMime(' Image/JPEG ')).toBe('image');
    expect(mediaKindForMime('video/mp4; codecs=avc1')).toBe('video');
    expect(mediaKindForMime('application/pdf')).toBeUndefined();
    expect(mediaKindForMime('text/plain')).toBeUndefined();
  });

  it('classifies content parts by their type', () => {
    const image: ContentPart = { type: 'image_url', imageUrl: { url: 'https://x/y.png' } };
    const video: ContentPart = { type: 'video_url', videoUrl: { url: 'https://x/y.mp4' } };
    const text: ContentPart = { type: 'text', text: 'hi' };
    expect(mediaKindOfPart(image)).toBe('image');
    expect(mediaKindOfPart(video)).toBe('video');
    expect(mediaKindOfPart(text)).toBeUndefined();
  });

  it('keeps the suffix tables mapping to the expected MIME families', () => {
    expect(IMAGE_MIME_BY_SUFFIX['.png']).toBe('image/png');
    expect(VIDEO_MIME_BY_SUFFIX['.mkv']).toBe('video/x-matroska');
  });
});

describe('daemon file URL', () => {
  it('round-trips fileId and path', () => {
    const url = buildDaemonFileUrl('file_1', '/a b/clip.mp4');
    expect(url).toBe('kimi-file://file_1?path=%2Fa%20b%2Fclip.mp4');
    expect(parseDaemonFileUrl(url)).toEqual({ fileId: 'file_1', path: '/a b/clip.mp4' });
  });

  it('builds and parses a bare reference without path', () => {
    expect(buildDaemonFileUrl('file_1')).toBe('kimi-file://file_1');
    expect(parseDaemonFileUrl('kimi-file://file_1')).toEqual({ fileId: 'file_1' });
    expect(buildDaemonFileUrl('file_1', '')).toBe('kimi-file://file_1');
    expect(parseDaemonFileUrl('kimi-file://file_1?path=')).toEqual({ fileId: 'file_1' });
  });

  it('rejects non-daemon URLs and empty file ids', () => {
    expect(isDaemonFileUrl('kimi-file://file_1')).toBe(true);
    expect(isDaemonFileUrl('ms://file_1')).toBe(false);
    expect(parseDaemonFileUrl('ms://prov-1')).toBeUndefined();
    expect(parseDaemonFileUrl('data:video/mp4;base64,AAAA')).toBeUndefined();
    expect(parseDaemonFileUrl('https://example.com/clip.mp4')).toBeUndefined();
    expect(parseDaemonFileUrl('kimi-file://')).toBeUndefined();
    expect(parseDaemonFileUrl('kimi-file://?path=%2Fa')).toBeUndefined();
  });

  it('drops an undecodable path but keeps the file id', () => {
    expect(parseDaemonFileUrl('kimi-file://file_1?path=%E0%A4%A')).toEqual({ fileId: 'file_1' });
  });

  it('extracts references from media parts with the part-implied kind', () => {
    const url = buildDaemonFileUrl('file_1', '/cache/a.png');
    expect(
      daemonFileRefFromPart({ type: 'image_url', imageUrl: { url } }),
    ).toEqual({ kind: 'image', ref: { fileId: 'file_1', path: '/cache/a.png' } });
    expect(
      daemonFileRefFromPart({ type: 'video_url', videoUrl: { url } }),
    ).toEqual({ kind: 'video', ref: { fileId: 'file_1', path: '/cache/a.png' } });
    expect(
      daemonFileRefFromPart({ type: 'image_url', imageUrl: { url: 'data:image/png;base64,AA' } }),
    ).toBeUndefined();
    expect(daemonFileRefFromPart({ type: 'text', text: url })).toBeUndefined();
  });
});

describe('media path tags', () => {
  it('round-trips through build and match', () => {
    const text = `before ${buildMediaPathTag('image', '/cache/a b.png')} after`;
    expect(text).toBe('before <image path="/cache/a b.png"></image> after');
    expect(matchMediaPathTags(text)).toEqual([
      {
        kind: 'image',
        path: '/cache/a b.png',
        index: 7,
        text: '<image path="/cache/a b.png"></image>',
      },
    ]);
  });

  it('escapes and unescapes attribute entities', () => {
    const tag = buildMediaPathTag('video', '/a & "b"/<c>.mp4');
    expect(tag).toBe('<video path="/a &amp; &quot;b&quot;/&lt;c&gt;.mp4"></video>');
    expect(matchMediaPathTags(tag)[0]?.path).toBe('/a & "b"/<c>.mp4');
  });

  it('tolerates extra attributes and a missing closing tag', () => {
    expect(matchMediaPathTags('<image path="/a.png" content_type="image/png">')).toEqual([
      {
        kind: 'image',
        path: '/a.png',
        index: 0,
        text: '<image path="/a.png" content_type="image/png">',
      },
    ]);
    expect(matchMediaPathTags('<video path="/b.mp4">')[0]?.path).toBe('/b.mp4');
  });

  it('matches every tag in order across kinds', () => {
    const tags = matchMediaPathTags(
      '<image path="/a.png"></image> text <video path="/b.mp4"></video> <file path="/c.pdf"></file>',
    );
    expect(tags.map((t) => t.kind)).toEqual(['image', 'video', 'file']);
    expect(tags.map((t) => t.path)).toEqual(['/a.png', '/b.mp4', '/c.pdf']);
  });

  it('ignores lookalikes without a path attribute', () => {
    expect(matchMediaPathTags('<image src="/a.png">')).toEqual([]);
    expect(matchMediaPathTags('path="/a.png"')).toEqual([]);
  });
});

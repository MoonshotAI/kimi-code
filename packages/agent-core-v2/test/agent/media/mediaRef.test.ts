import { describe, expect, it } from 'vitest';

import type { ContentPart } from '#/kosong/contract/message';
import {
  AUDIO_MIME_BY_SUFFIX,
  IMAGE_MIME_BY_SUFFIX,
  VIDEO_MIME_BY_SUFFIX,
  buildDaemonFileUrl,
  buildMediaPathTag,
  daemonFileRefFromPart,
  isDaemonFileUrl,
  matchMediaPathTags,
  matchSingleMediaPathTag,
  mediaKindForMime,
  mediaKindForPath,
  mediaKindOfPart,
  parseDaemonFileUrl,
} from '#/agent/media/mediaRef';

describe('media kind classification', () => {
  it('classifies paths by suffix, case-insensitively', () => {
    expect(mediaKindForPath('/a/b/shot.PNG')).toBe('image');
    expect(mediaKindForPath('clip.mp4')).toBe('video');
    expect(mediaKindForPath('song.MP3')).toBe('audio');
    expect(mediaKindForPath('/a/b/track.weba')).toBe('audio');
    expect(mediaKindForPath('/a.b/clip')).toBeUndefined();
    expect(mediaKindForPath('/a/shot.')).toBeUndefined();
    expect(mediaKindForPath('notes.txt')).toBeUndefined();
  });

  it('classifies MIME types, ignoring case and parameters', () => {
    expect(mediaKindForMime('image/png')).toBe('image');
    expect(mediaKindForMime(' Image/JPEG ')).toBe('image');
    expect(mediaKindForMime('video/mp4; codecs=avc1')).toBe('video');
    expect(mediaKindForMime('audio/mpeg')).toBe('audio');
    expect(mediaKindForMime(' Audio/OGG; codecs=opus ')).toBe('audio');
    expect(mediaKindForMime('application/pdf')).toBeUndefined();
    expect(mediaKindForMime('text/plain')).toBeUndefined();
  });

  it('classifies content parts by their type', () => {
    const image: ContentPart = { type: 'image_url', imageUrl: { url: 'https://x/y.png' } };
    const video: ContentPart = { type: 'video_url', videoUrl: { url: 'https://x/y.mp4' } };
    const audio: ContentPart = { type: 'audio_url', audioUrl: { url: 'https://x/y.mp3' } };
    const text: ContentPart = { type: 'text', text: 'hi' };
    expect(mediaKindOfPart(image)).toBe('image');
    expect(mediaKindOfPart(video)).toBe('video');
    expect(mediaKindOfPart(audio)).toBe('audio');
    expect(mediaKindOfPart(text)).toBeUndefined();
  });

  it('keeps the suffix tables mapping to the expected MIME families', () => {
    expect(IMAGE_MIME_BY_SUFFIX['.png']).toBe('image/png');
    expect(VIDEO_MIME_BY_SUFFIX['.mkv']).toBe('video/x-matroska');
    expect(AUDIO_MIME_BY_SUFFIX['.mp3']).toBe('audio/mpeg');
    expect(AUDIO_MIME_BY_SUFFIX['.weba']).toBe('audio/webm');
  });
});

describe('daemon file URL', () => {
  it('builds and parses a bare reference', () => {
    expect(buildDaemonFileUrl('file_1')).toBe('kimi-file://file_1');
    expect(parseDaemonFileUrl('kimi-file://file_1')).toEqual({ fileId: 'file_1' });
  });

  it('strips a legacy `?path=` query at parse time', () => {
    expect(parseDaemonFileUrl('kimi-file://file_1?path=%2Fa%20b%2Fclip.mp4')).toEqual({
      fileId: 'file_1',
    });
    expect(parseDaemonFileUrl('kimi-file://file_1?path=')).toEqual({ fileId: 'file_1' });
    expect(parseDaemonFileUrl('kimi-file://file_1?path=%E0%A4%A')).toEqual({ fileId: 'file_1' });
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

  it('extracts references from media parts with the part-implied kind', () => {
    const url = buildDaemonFileUrl('file_1');
    expect(
      daemonFileRefFromPart({ type: 'image_url', imageUrl: { url } }),
    ).toEqual({ kind: 'image', ref: { fileId: 'file_1' } });
    expect(
      daemonFileRefFromPart({ type: 'video_url', videoUrl: { url } }),
    ).toEqual({ kind: 'video', ref: { fileId: 'file_1' } });
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
      '<image path="/a.png"></image> text <video path="/b.mp4"></video> <audio path="/c.mp3"></audio> <file path="/d.pdf"></file>',
    );
    expect(tags.map((t) => t.kind)).toEqual(['image', 'video', 'audio', 'file']);
    expect(tags.map((t) => t.path)).toEqual(['/a.png', '/b.mp4', '/c.mp3', '/d.pdf']);
  });

  it('round-trips an audio tag through build and match', () => {
    const tag = buildMediaPathTag('audio', '/cache/a b.mp3');
    expect(tag).toBe('<audio path="/cache/a b.mp3"></audio>');
    expect(matchMediaPathTags(tag)).toEqual([
      { kind: 'audio', path: '/cache/a b.mp3', index: 0, text: tag },
    ]);
  });

  it('ignores lookalikes without a path attribute', () => {
    expect(matchMediaPathTags('<image src="/a.png">')).toEqual([]);
    expect(matchMediaPathTags('path="/a.png"')).toEqual([]);
  });
});

describe('matchSingleMediaPathTag', () => {
  it('matches a text that is exactly one tag', () => {
    expect(matchSingleMediaPathTag('<image path="/a.png"></image>')).toEqual({
      kind: 'image',
      path: '/a.png',
      index: 0,
      text: '<image path="/a.png"></image>',
    });
    expect(matchSingleMediaPathTag('  <video path="/b.mp4">\n')).toMatchObject({
      kind: 'video',
      path: '/b.mp4',
    });
    expect(matchSingleMediaPathTag('<image path="/a.png" content_type="image/png">')).toMatchObject(
      { kind: 'image', path: '/a.png' },
    );
  });

  it('rejects tags embedded in user text and multi-tag text', () => {
    expect(matchSingleMediaPathTag('look <image path="/a.png"></image>')).toBeUndefined();
    expect(matchSingleMediaPathTag('<image path="/a.png"></image> please')).toBeUndefined();
    expect(
      matchSingleMediaPathTag('<image path="/a.png"></image><image path="/b.png"></image>'),
    ).toBeUndefined();
    expect(matchSingleMediaPathTag('plain text')).toBeUndefined();
  });
});


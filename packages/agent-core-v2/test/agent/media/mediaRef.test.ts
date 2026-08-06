/**
 * `agent/media` mediaRef — media classification, daemon file references,
 * and media path tags.
 *
 *   - suffix / MIME / content-part classification (`mediaKindFor*` /
 *     `mediaKindOfPart`)
 *   - `kimi-file://` daemon file URL build/parse round-trips
 *   - `<image|video|audio|file path="…">` tag emission and matching,
 *     including the legacy no-closing-tag and extra-attribute shapes
 */

import { describe, expect, it } from 'vitest';

import type { ContentPart } from '#/kosong/contract/message';
import {
  AUDIO_MIME_BY_SUFFIX,
  IMAGE_MIME_BY_SUFFIX,
  VIDEO_MIME_BY_SUFFIX,
  buildDaemonFileUrl,
  buildMediaPathTag,
  daemonFileRefFromPart,
  foldMediaPathTagRefs,
  isDaemonFileUrl,
  matchMediaPathTags,
  matchSingleMediaPathTag,
  mediaKindForMime,
  mediaKindForPath,
  mediaKindOfPart,
  pairMediaPathTagRefs,
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

describe('foldMediaPathTagRefs', () => {
  const daemonImage = (fileId: string, path?: string): ContentPart => ({
    type: 'image_url',
    imageUrl: { url: buildDaemonFileUrl(fileId, path) },
  });

  it('folds a tag-before-ref pair into one media entry carrying the tag path', () => {
    const ref = daemonImage('file_1', '/cache/shot.png');
    const fold = foldMediaPathTagRefs([
      { type: 'text', text: 'what is this?' },
      { type: 'text', text: '<image path="/cache/shot.png"></image>' },
      ref,
    ]);
    expect(fold.parts).toEqual([{ type: 'text', text: 'what is this?' }, ref]);
    expect(fold.media).toEqual([
      { kind: 'image', ref: { fileId: 'file_1', path: '/cache/shot.png' }, path: '/cache/shot.png' },
    ]);
  });

  it('folds a ref-before-tag pair the same way', () => {
    const ref = daemonImage('file_1', '/cache/shot.png');
    const fold = foldMediaPathTagRefs([
      ref,
      { type: 'text', text: '<image path="/cache/shot.png"></image>' },
    ]);
    expect(fold.parts).toEqual([ref]);
    expect(fold.media).toEqual([
      { kind: 'image', ref: { fileId: 'file_1', path: '/cache/shot.png' }, path: '/cache/shot.png' },
    ]);
  });

  it('keeps an unpaired standalone tag as text', () => {
    const tag: ContentPart = { type: 'text', text: '<image path="/cache/shot.png">' };
    const fold = foldMediaPathTagRefs([tag, { type: 'text', text: 'kept' }]);
    expect(fold.parts).toEqual([tag, { type: 'text', text: 'kept' }]);
    expect(fold.media).toEqual([]);
  });

  it('keeps a bare ref as pathless media', () => {
    const ref = daemonImage('file_1');
    const fold = foldMediaPathTagRefs([ref]);
    expect(fold.parts).toEqual([ref]);
    expect(fold.media).toEqual([{ kind: 'image', ref: { fileId: 'file_1' }, path: undefined }]);
  });

  it('leaves non-daemon media parts untouched and out of the media list', () => {
    const remote: ContentPart = { type: 'image_url', imageUrl: { url: 'https://example.com/a.png' } };
    const fold = foldMediaPathTagRefs([remote]);
    expect(fold.parts).toEqual([remote]);
    expect(fold.media).toEqual([]);
  });

  it('neither pairs nor drops a kind-mismatched adjacent tag', () => {
    const tag: ContentPart = { type: 'text', text: '<image path="/cache/clip.mp4"></image>' };
    const ref: ContentPart = {
      type: 'video_url',
      videoUrl: { url: buildDaemonFileUrl('file_1', '/cache/clip.mp4') },
    };
    const fold = foldMediaPathTagRefs([tag, ref]);
    expect(fold.parts).toEqual([tag, ref]);
    expect(fold.media).toEqual([
      { kind: 'video', ref: { fileId: 'file_1', path: '/cache/clip.mp4' }, path: undefined },
    ]);
  });

  it('pairs a file-kind tag with either ref kind when the path matches', () => {
    const ref = daemonImage('file_1', '/cache/shot.png');
    const fold = foldMediaPathTagRefs([{ type: 'text', text: '<file path="/cache/shot.png">' }, ref]);
    expect(fold.parts).toEqual([ref]);
    expect(fold.media[0]?.path).toBe('/cache/shot.png');
  });

  it('does not pair an adjacent tag whose path differs from the reference path', () => {
    const tag: ContentPart = { type: 'text', text: '<image path="/cache/other.png"></image>' };
    const ref = daemonImage('file_1', '/cache/shot.png');
    const fold = foldMediaPathTagRefs([tag, ref]);
    expect(fold.parts).toEqual([tag, ref]);
    expect(fold.media).toEqual([
      { kind: 'image', ref: { fileId: 'file_1', path: '/cache/shot.png' }, path: undefined },
    ]);
  });

  it('never pairs a reference that carries no path — both sides stay', () => {
    const tag: ContentPart = { type: 'text', text: '<image path="/cache/shot.png"></image>' };
    const ref = daemonImage('file_1');
    const fold = foldMediaPathTagRefs([tag, ref]);
    expect(fold.parts).toEqual([tag, ref]);
    expect(fold.media).toEqual([{ kind: 'image', ref: { fileId: 'file_1' }, path: undefined }]);
  });

  it('claims the tag for the path-matching ref, not the adjacent bare one', () => {
    // [bareRefA, tagB, refB]: adjacency alone would misassign tagB to refA.
    const bareRefA = daemonImage('file_1', '/cache/a.png');
    const refB = daemonImage('file_2', '/cache/b.png');
    const fold = foldMediaPathTagRefs([
      bareRefA,
      { type: 'text', text: '<image path="/cache/b.png"></image>' },
      refB,
    ]);
    expect(fold.parts).toEqual([bareRefA, refB]);
    expect(fold.media).toEqual([
      { kind: 'image', ref: { fileId: 'file_1', path: '/cache/a.png' }, path: undefined },
      { kind: 'image', ref: { fileId: 'file_2', path: '/cache/b.png' }, path: '/cache/b.png' },
    ]);
  });

  it('claims a tag for at most one ref', () => {
    const first = daemonImage('file_1', '/cache/a.png');
    const second = daemonImage('file_2', '/cache/a.png');
    const fold = foldMediaPathTagRefs([
      first,
      { type: 'text', text: '<image path="/cache/a.png"></image>' },
      second,
    ]);
    expect(fold.parts).toEqual([first, second]);
    expect(fold.media.map((m) => m.path)).toEqual(['/cache/a.png', undefined]);
  });

  it('claims at most one tag per ref, keeping the unclaimed tag as text', () => {
    const ref = daemonImage('file_1', '/cache/shot.png');
    const secondTag: ContentPart = { type: 'text', text: '<image path="/cache/shot.png"></image>' };
    const fold = foldMediaPathTagRefs([
      { type: 'text', text: '<image path="/cache/shot.png"></image>' },
      ref,
      secondTag,
    ]);
    expect(fold.parts).toEqual([ref, secondTag]);
    expect(fold.media.map((m) => m.path)).toEqual(['/cache/shot.png']);
  });

  it('keeps user text with an inline tag verbatim', () => {
    const text: ContentPart = { type: 'text', text: 'open <image path="/a.png"></image> please' };
    const fold = foldMediaPathTagRefs([text]);
    expect(fold.parts).toEqual([text]);
    expect(fold.media).toEqual([]);
  });
});

describe('pairMediaPathTagRefs', () => {
  const daemonImage = (fileId: string, path?: string): ContentPart => ({
    type: 'image_url',
    imageUrl: { url: buildDaemonFileUrl(fileId, path) },
  });

  it('reports the claimed tag indices and the per-ref claimed paths', () => {
    const ref = daemonImage('file_1', '/cache/shot.png');
    const pairing = pairMediaPathTagRefs([
      { type: 'text', text: '<image path="/cache/shot.png"></image>' },
      ref,
    ]);
    expect(pairing.claimedTagIndices).toEqual(new Set([0]));
    expect(pairing.claimedPathByRefIndex).toEqual(new Map([[1, '/cache/shot.png']]));
  });

  it('claims nothing when the adjacent tag carries a different path', () => {
    const pairing = pairMediaPathTagRefs([
      { type: 'text', text: '<image path="/cache/other.png"></image>' },
      daemonImage('file_1', '/cache/shot.png'),
    ]);
    expect(pairing.claimedTagIndices.size).toBe(0);
    expect(pairing.claimedPathByRefIndex.size).toBe(0);
  });

  it('claims nothing for a reference without a path', () => {
    const pairing = pairMediaPathTagRefs([
      { type: 'text', text: '<image path="/cache/shot.png"></image>' },
      daemonImage('file_1'),
    ]);
    expect(pairing.claimedTagIndices.size).toBe(0);
    expect(pairing.claimedPathByRefIndex.size).toBe(0);
  });
});

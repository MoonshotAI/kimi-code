/**
 * Parity pin for the daemon-ref / media-tag grammar, which lives in TWO
 * packages that may not import each other: the engine
 * (`agent-core-v2/agent/media/mediaRef.ts`, drives the request-time
 * resolver's drop/synthesize decisions) and the transcript read-model mirror
 * (`transcript/contract/mediaRef.ts`, drives the cold-rebuild projection).
 * The two header comments say "keep the two in sync" — this test is what
 * actually enforces it: both implementations must answer identically for
 * every fixture below, so a grammar change landed on only one side fails
 * here instead of drifting the live projection apart from the cold rebuild.
 *
 * The shared surface is threefold: `kimi-file://` url parsing, the
 * standalone `<media path>` tag matcher, and the single-part daemon-ref
 * extraction (`daemonFileRefFromPart` vs `daemonFileRefFromPairingPart`).
 */

import { describe, expect, it } from 'vitest';

import {
  daemonFileRefFromPart as engineRefFromPart,
  matchSingleMediaPathTag as engineMatchTag,
  parseDaemonFileUrl as engineParse,
} from '@moonshot-ai/agent-core-v2';
import {
  daemonFileRefFromPairingPart as mirrorRefFromPart,
  matchMediaPathTagText as mirrorMatchTag,
  parseDaemonFileRef as mirrorParse,
  type MediaRefPart,
} from '@moonshot-ai/transcript';
import type { ContentPart } from '@moonshot-ai/agent-core-v2/kosong/contract/message';

const URLS = [
  'kimi-file://f_1?path=%2Fcache%2Fshot.png',
  'kimi-file://f_1',
  'kimi-file://f_1?path=',
  'kimi-file://?path=%2Fcache%2Fshot.png',
  // A legacy `?path=` query is stripped, however it was encoded.
  'kimi-file://f_1?path=%2Fcache%2Fa%20%26%20%22b%22%20%3Cc%3E.png',
  'kimi-file://f_1?path=%zz',
  'kimi-file://',
  'https://example.com/shot.png',
  '',
];

describe('daemon file url parsing parity (engine vs transcript mirror)', () => {
  for (const url of URLS) {
    it(JSON.stringify(url), () => {
      expect(mirrorParse(url)).toEqual(engineParse(url));
    });
  }
});

const TAG_TEXTS = [
  '<image path="/cache/shot.png"></image>',
  // A missing closing tag is tolerated.
  '<image path="/cache/shot.png">',
  // Extra attributes are tolerated.
  '<image content_type="image/png" path="/cache/shot.png">',
  // Surrounding whitespace is tolerated.
  '  <image path="/cache/shot.png"></image>\n',
  // Escaped path characters round-trip.
  '<image path="/cache/a &amp; &quot;b&quot; &lt;c&gt;.png"></image>',
  // A tag embedded in user text is never matched.
  'open <image path="/cache/shot.png"></image> please',
  // Two tags are not a standalone tag.
  '<image path="/cache/shot.png"></image><image path="/cache/other.png"></image>',
  'plain text',
  '',
];

describe('standalone media path tag matching parity', () => {
  for (const text of TAG_TEXTS) {
    it(JSON.stringify(text), () => {
      const engine = engineMatchTag(text);
      const mirror = mirrorMatchTag(text);
      expect(mirror === undefined ? undefined : { kind: mirror.kind, path: mirror.path }).toEqual(
        engine === undefined ? undefined : { kind: engine.kind, path: engine.path },
      );
    });
  }
});

const PARTS: ReadonlyArray<MediaRefPart> = [
  { type: 'image_url', imageUrl: { url: 'kimi-file://f_1?path=%2Fcache%2Fshot.png' } },
  { type: 'video_url', videoUrl: { url: 'kimi-file://f_3?path=%2Fcache%2Fclip.mp4' } },
  { type: 'image_url', imageUrl: { url: 'kimi-file://f_1' } },
  { type: 'image_url', imageUrl: { url: 'https://example.com/shot.png' } },
  { type: 'text', text: '<image path="/cache/shot.png"></image>' },
  { type: 'text', text: 'hello' },
];

describe('daemon ref extraction parity', () => {
  for (const [index, part] of PARTS.entries()) {
    it(`part ${index}: ${part.type}`, () => {
      expect(mirrorRefFromPart(part)).toEqual(
        engineRefFromPart(part as unknown as ContentPart),
      );
    });
  }
});

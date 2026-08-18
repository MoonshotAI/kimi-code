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
  '<image path="/cache/shot.png">',
  '<image content_type="image/png" path="/cache/shot.png">',
  '  <image path="/cache/shot.png"></image>\n',
  '<image path="/cache/a &amp; &quot;b&quot; &lt;c&gt;.png"></image>',
  'open <image path="/cache/shot.png"></image> please',
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

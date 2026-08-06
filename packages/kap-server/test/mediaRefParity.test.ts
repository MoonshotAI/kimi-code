/**
 * Parity pin for the media tag+ref pairing algorithm, which lives in TWO
 * packages that may not import each other: the engine
 * (`agent-core-v2/agent/media/mediaRef.ts`, drives the request-time
 * resolver's drop/synthesize decisions) and the transcript read-model mirror
 * (`transcript/contract/mediaRef.ts`, drives the cold-rebuild fold). The two
 * header comments say "keep the two in sync" — this test is what actually
 * enforces it: both implementations must produce the identical pairing for
 * every fixture below, so a rule change landed on only one side fails here
 * instead of drifting the live projection apart from the cold rebuild.
 */

import { describe, expect, it } from 'vitest';

import { pairMediaPathTagRefs as enginePair } from '@moonshot-ai/agent-core-v2';
import {
  pairMediaPathTagRefs as mirrorPair,
  type MediaRefPairingPart,
} from '@moonshot-ai/transcript';
import type { ContentPart } from '@moonshot-ai/agent-core-v2/kosong/contract/message';

interface PairingLike {
  readonly claimedTagIndices: ReadonlySet<number>;
  readonly claimedPathByRefIndex: ReadonlyMap<number, string>;
  readonly claimingRefByTagIndex: ReadonlyMap<number, number>;
}

function normalize(pairing: PairingLike): { tags: number[]; paths: [number, string][]; refs: [number, number][] } {
  return {
    tags: [...pairing.claimedTagIndices].toSorted((a, b) => a - b),
    paths: [...pairing.claimedPathByRefIndex.entries()].toSorted((a, b) => a[0] - b[0]),
    refs: [...pairing.claimingRefByTagIndex.entries()].toSorted((a, b) => a[0] - b[0]),
  };
}

const text = (value: string): MediaRefPairingPart => ({ type: 'text', text: value });
const imageRef = (url: string): MediaRefPairingPart => ({ type: 'image_url', imageUrl: { url } });
const videoRef = (url: string): MediaRefPairingPart => ({ type: 'video_url', videoUrl: { url } });
const REF_IMAGE = 'kimi-file://f_1?path=%2Fcache%2Fshot.png';
const REF_IMAGE_2 = 'kimi-file://f_2?path=%2Fcache%2Fshot.png';
const REF_VIDEO = 'kimi-file://f_3?path=%2Fcache%2Fclip.mp4';

const FIXTURES: ReadonlyArray<{ readonly name: string; readonly parts: readonly MediaRefPairingPart[] }> = [
  // The edge-emitted pair, tag before ref.
  { name: 'tag before ref pairs', parts: [text('<image path="/cache/shot.png"></image>'), imageRef(REF_IMAGE)] },
  // Persisted history also has ref before tag.
  { name: 'ref before tag pairs', parts: [imageRef(REF_IMAGE), text('<image path="/cache/shot.png"></image>')] },
  // Kind mismatch never pairs.
  { name: 'kind mismatch does not pair', parts: [text('<video path="/cache/shot.png"></video>'), imageRef(REF_IMAGE)] },
  // A `file` tag matches either ref kind.
  { name: 'file tag matches a video ref', parts: [text('<file path="/cache/clip.mp4"></file>'), videoRef(REF_VIDEO)] },
  // Path mismatch never pairs.
  { name: 'path mismatch does not pair', parts: [text('<image path="/cache/other.png"></image>'), imageRef(REF_IMAGE)] },
  // A reference without a path can never pair.
  { name: 'pathless ref does not pair', parts: [text('<image path="/cache/shot.png"></image>'), imageRef('kimi-file://f_1')] },
  // A tag embedded in user text is not a standalone tag.
  { name: 'embedded tag does not pair', parts: [text('open <image path="/cache/shot.png"></image> please'), imageRef(REF_IMAGE)] },
  // Single claim, references check the part before them first.
  {
    name: 'two tags one ref: the leading tag is claimed',
    parts: [
      text('<image path="/cache/shot.png"></image>'),
      imageRef(REF_IMAGE),
      text('<image path="/cache/shot.png"></image>'),
    ],
  },
  {
    name: 'two refs one tag: the earlier ref claims it',
    parts: [imageRef(REF_IMAGE), text('<image path="/cache/shot.png"></image>'), imageRef(REF_IMAGE_2)],
  },
  // Extra attributes and a missing closing tag are tolerated.
  { name: 'extra attributes and missing closing tag', parts: [text('<image content_type="image/png" path="/cache/shot.png">'), imageRef(REF_IMAGE)] },
  // Escaped path characters round-trip.
  {
    name: 'escaped path characters round-trip',
    parts: [
      text('<image path="/cache/a &amp; &quot;b&quot; &lt;c&gt;.png"></image>'),
      imageRef('kimi-file://f_1?path=%2Fcache%2Fa%20%26%20%22b%22%20%3Cc%3E.png'),
    ],
  },
  // A non-daemon url is not a reference.
  { name: 'non-daemon url does not pair', parts: [text('<image path="/cache/shot.png"></image>'), imageRef('https://example.com/shot.png')] },
  // An audio tag does not pair with an image ref.
  { name: 'audio tag does not pair with an image ref', parts: [text('<audio path="/cache/shot.png"></audio>'), imageRef(REF_IMAGE)] },
  // Surrounding whitespace is tolerated for the standalone tag.
  { name: 'whitespace around a standalone tag', parts: [text('  <image path="/cache/shot.png"></image>\n'), imageRef(REF_IMAGE)] },
  // An unrelated part between tag and ref breaks adjacency.
  {
    name: 'an intervening part breaks adjacency',
    parts: [text('<image path="/cache/shot.png"></image>'), text('caption'), imageRef(REF_IMAGE)],
  },
  // Same path on different fileIds, interleaved: each tag claims its own ref
  // (the claim mapping must not be recovered by path equality).
  {
    name: 'same-path interleaved pairs claim their own ref',
    parts: [
      text('<image path="/cache/shot.png"></image>'),
      imageRef(REF_IMAGE),
      text('<image path="/cache/shot.png"></image>'),
      imageRef(REF_IMAGE_2),
    ],
  },
];

describe('media tag+ref pairing parity (engine vs transcript mirror)', () => {
  FIXTURES.forEach(({ name, parts }) => {
    it(name, () => {
      const engine = normalize(enginePair(parts as unknown as ContentPart[]));
      const mirror = normalize(mirrorPair(parts));
      expect(mirror).toEqual(engine);
    });
  });

  it('pins the expected claims, not just cross-implementation equality', () => {
    const byName = (name: string): readonly MediaRefPairingPart[] => {
      const fixture = FIXTURES.find((f) => f.name === name);
      if (fixture === undefined) throw new Error(`fixture not found: ${name}`);
      return fixture.parts;
    };
    expect(normalize(enginePair(byName('tag before ref pairs') as unknown as ContentPart[]))).toEqual({
      tags: [0],
      paths: [[1, '/cache/shot.png']],
      refs: [[0, 1]],
    });
    expect(normalize(enginePair(byName('two refs one tag: the earlier ref claims it') as unknown as ContentPart[]))).toEqual({
      tags: [1],
      paths: [[0, '/cache/shot.png']],
      refs: [[1, 0]],
    });
    expect(normalize(enginePair(byName('escaped path characters round-trip') as unknown as ContentPart[]))).toEqual({
      tags: [0],
      paths: [[1, '/cache/a & "b" <c>.png']],
      refs: [[0, 1]],
    });
    expect(normalize(enginePair(byName('same-path interleaved pairs claim their own ref') as unknown as ContentPart[]))).toEqual({
      tags: [0, 2],
      paths: [
        [1, '/cache/shot.png'],
        [3, '/cache/shot.png'],
      ],
      refs: [
        [0, 1],
        [2, 3],
      ],
    });
  });
});

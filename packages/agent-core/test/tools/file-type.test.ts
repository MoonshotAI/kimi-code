/**
 * file-type — magic-byte + extension detection.
 *
 * Tests pin:
 *   - magic-byte recognition for PNG / JPEG / GIF / WebP / AVIF /
 *     MP4 ftyp / MKV / AVI
 *   - extension lookup for each `IMAGE_MIME_BY_SUFFIX` / `VIDEO_MIME_BY_SUFFIX`
 *   - NUL bytes → unknown
 *   - extension hints a different kind than sniff → unknown
 *   - `NON_TEXT_SUFFIXES` lookup returns unknown (so binaries aren't
 *     treated as text on a blind read)
 *   - no header provided → extension-only detection
 */

import { describe, expect, it } from 'vitest';

// eslint-disable-next-line import/no-unresolved
import {
  detectFileType,
  sniffImageDimensions,
  sniffMediaFromMagic,
  MEDIA_SNIFF_BYTES,
  IMAGE_MIME_BY_SUFFIX,
  VIDEO_MIME_BY_SUFFIX,
  NON_TEXT_SUFFIXES,
  type FileType,
  type ImageDimensions,
} from '../../src/tools/support/file-type';

describe('sniffMediaFromMagic', () => {
  it('recognises PNG magic bytes', () => {
    const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    expect(sniffMediaFromMagic(header)).toEqual<FileType>({
      kind: 'image',
      mimeType: 'image/png',
    });
  });

  it('recognises JPEG magic bytes', () => {
    const header = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
    expect(sniffMediaFromMagic(header)).toEqual<FileType>({
      kind: 'image',
      mimeType: 'image/jpeg',
    });
  });

  it('recognises GIF87a and GIF89a magic bytes', () => {
    expect(sniffMediaFromMagic(Buffer.from('GIF87a\0\0', 'binary'))).toEqual<FileType>({
      kind: 'image',
      mimeType: 'image/gif',
    });
    expect(sniffMediaFromMagic(Buffer.from('GIF89a\0\0', 'binary'))).toEqual<FileType>({
      kind: 'image',
      mimeType: 'image/gif',
    });
  });

  it('recognises WebP magic bytes (RIFF…WEBP)', () => {
    const header = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from('WEBP'),
    ]);
    expect(sniffMediaFromMagic(header)).toEqual<FileType>({
      kind: 'image',
      mimeType: 'image/webp',
    });
  });

  it('recognises AVIF via ftyp brand', () => {
    const header = Buffer.concat([
      Buffer.from([0, 0, 0, 0x20]),
      Buffer.from('ftyp'),
      Buffer.from('avif'),
      Buffer.alloc(16),
    ]);
    expect(sniffMediaFromMagic(header)).toEqual<FileType>({
      kind: 'image',
      mimeType: 'image/avif',
    });
  });

  it('recognises MP4 via ftyp mp42/isom brand', () => {
    const header = Buffer.concat([
      Buffer.from([0, 0, 0, 0x18]),
      Buffer.from('ftyp'),
      Buffer.from('mp42'),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from('mp42isom'),
    ]);
    const result = sniffMediaFromMagic(header);
    expect(result?.kind).toBe('video');
    expect(result?.mimeType).toBe('video/mp4');
  });

  it('recognises Matroska / WebM via EBML header', () => {
    const ebml = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
    const matroskaHeader = Buffer.concat([ebml, Buffer.from('.matroska.', 'binary')]);
    expect(sniffMediaFromMagic(matroskaHeader)).toEqual<FileType>({
      kind: 'video',
      mimeType: 'video/x-matroska',
    });
    const webmHeader = Buffer.concat([ebml, Buffer.from('.webm.', 'binary')]);
    expect(sniffMediaFromMagic(webmHeader)).toEqual<FileType>({
      kind: 'video',
      mimeType: 'video/webm',
    });
  });

  it('recognises AVI via RIFF…AVI ', () => {
    const header = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from('AVI '),
    ]);
    expect(sniffMediaFromMagic(header)).toEqual<FileType>({
      kind: 'video',
      mimeType: 'video/x-msvideo',
    });
  });

  it('returns null for unrecognised magic bytes', () => {
    expect(sniffMediaFromMagic(Buffer.from('plain text content'))).toBeNull();
  });

  it('uses MEDIA_SNIFF_BYTES as the header slice size ceiling', () => {
    // Typed constant guard.
    expect(MEDIA_SNIFF_BYTES).toBe(512);
  });
});

describe('detectFileType', () => {
  it('resolves images by extension when no header is given', () => {
    expect(detectFileType('foo.png')).toEqual<FileType>({
      kind: 'image',
      mimeType: 'image/png',
    });
    expect(detectFileType('foo.JPG')).toEqual<FileType>({
      kind: 'image',
      mimeType: 'image/jpeg',
    });
    expect(detectFileType('foo.heic')).toEqual<FileType>({
      kind: 'image',
      mimeType: 'image/heic',
    });
  });

  it('resolves videos by extension when no header is given', () => {
    expect(detectFileType('foo.mp4')).toEqual<FileType>({
      kind: 'video',
      mimeType: 'video/mp4',
    });
    expect(detectFileType('foo.mpg')).toEqual<FileType>({
      kind: 'video',
      mimeType: 'video/mpeg',
    });
    expect(detectFileType('foo.mpeg')).toEqual<FileType>({
      kind: 'video',
      mimeType: 'video/mpeg',
    });
    expect(detectFileType('foo.mkv')).toEqual<FileType>({
      kind: 'video',
      mimeType: 'video/x-matroska',
    });
    expect(detectFileType('foo.ogv')).toEqual<FileType>({
      kind: 'video',
      mimeType: 'video/ogg',
    });
    expect(detectFileType('foo.mov')).toEqual<FileType>({
      kind: 'video',
      mimeType: 'video/quicktime',
    });
  });

  it('treats .svg (text) as text, not image, even though the MIME is image/*', () => {
    // SVG is XML text even though its MIME says `image/svg+xml`.
    const result = detectFileType('pic.svg');
    expect(result.kind).toBe('text');
    expect(result.mimeType).toBe('image/svg+xml');
  });

  it('NUL byte in header → unknown (binary signal)', () => {
    const header = Buffer.concat([Buffer.from('partial'), Buffer.from([0x00, 0x00])]);
    const result = detectFileType('mystery.bin', header);
    expect(result.kind).toBe('unknown');
  });

  it('extension + sniff disagree → unknown', () => {
    // `.mp4` extension but JPEG magic bytes — when the mime types
    // disagree we refuse to guess and return `unknown`.
    const jpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const result = detectFileType('mismatch.mp4', jpegHeader);
    expect(result.kind).toBe('unknown');
  });

  it('can prefer the sniffed media header over the extension in media mode', () => {
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(detectFileType('mismatch.mp4', pngHeader, 'media')).toEqual<FileType>({
      kind: 'image',
      mimeType: 'image/png',
    });
  });

  it('falls back to a media extension in media mode when sniffing is inconclusive', () => {
    const mpegProgramStreamHeader = Buffer.from([0x00, 0x00, 0x01, 0xba, 0x21, 0x00]);
    expect(detectFileType('clip.mpg', mpegProgramStreamHeader, 'media')).toEqual<
      FileType
    >({
      kind: 'video',
      mimeType: 'video/mpeg',
    });
    expect(detectFileType('clip.mpg', mpegProgramStreamHeader).kind).toBe('unknown');
  });

  it('returns unknown for an image extension whose bytes fail to sniff', () => {
    // A `.png` file with no recognisable image magic and no NUL byte must not
    // be reported as `image/png` in either mode. In media mode it would build
    // a mismatched data URL the model API rejects as
    // `application/octet-stream`; in text mode it would redirect the user to
    // ReadMediaFile for a file that is not an image.
    const garbage = Buffer.from('plain ascii, definitely not a png');
    expect(detectFileType('fake.png', garbage, 'media').kind).toBe('unknown');
    expect(detectFileType('fake.png', garbage).kind).toBe('unknown');
  });

  it('extension in NON_TEXT_SUFFIXES → unknown', () => {
    // A `.zip` file with no header and no image/video hint must not
    // be treated as text.
    const result = detectFileType('archive.zip');
    expect(result.kind).toBe('unknown');
  });

  it('falls back to plain text for unknown suffix with no magic bytes', () => {
    const result = detectFileType('README');
    expect(result.kind).toBe('text');
    expect(result.mimeType).toBe('text/plain');
  });

  it('exposes the suffix maps as readonly records', () => {
    expect(IMAGE_MIME_BY_SUFFIX['.png']).toBe('image/png');
    expect(VIDEO_MIME_BY_SUFFIX['.mkv']).toBe('video/x-matroska');
    expect(NON_TEXT_SUFFIXES.has('.pdf')).toBe(true);
    expect(NON_TEXT_SUFFIXES.has('.zip')).toBe(true);
    expect(NON_TEXT_SUFFIXES.has('.dll')).toBe(true);
  });

  it('classifies common suffixes, dotfiles, and case-insensitive variants', () => {
    expect(detectFileType('image.PNG').kind).toBe('image');
    expect(detectFileType('clip.mp4').kind).toBe('video');
    expect(detectFileType('notes.txt').kind).toBe('text');
    // No suffix at all → falls through to text/plain.
    expect(detectFileType('Makefile').kind).toBe('text');
    // Leading dot-only names have no suffix → text/plain fallback.
    expect(detectFileType('.env').kind).toBe('text');
    expect(detectFileType('icon.svg').kind).toBe('text');
    expect(detectFileType('archive.tar.gz').kind).toBe('unknown');
    expect(detectFileType('my file.pdf').kind).toBe('unknown');
  });

  it('keeps TypeScript suffixes as text rather than MPEG-TS video', () => {
    // Regression lockdown: the `.ts` suffix maps to video/mp2t in some MIME
    // tables. We must NOT classify .ts/.tsx/.mts/.cts as video — they are
    // source files.
    expect(detectFileType('app.ts').kind).toBe('text');
    expect(detectFileType('component.tsx').kind).toBe('text');
    expect(detectFileType('module.mts').kind).toBe('text');
    expect(detectFileType('common.cts').kind).toBe('text');
  });

  it('header sniffing picks up extensionless video and refines unknown-suffix MIME', () => {
    const iso5Header = Buffer.concat([
      Buffer.from([0, 0, 0, 0x18]),
      Buffer.from('ftyp'),
      Buffer.from('iso5'),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from('iso5isom'),
    ]);
    expect(detectFileType('sample', iso5Header).kind).toBe('video');

    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    // .bin is in NON_TEXT_SUFFIXES; a sniffed PNG header refines it to image/png.
    expect(detectFileType('sample.bin', pngHeader).mimeType).toBe('image/png');

    // NUL byte in header overrides the .txt text hint.
    const binaryHeader = Buffer.concat([Buffer.from('partial'), Buffer.from([0x00, 0x00])]);
    expect(detectFileType('notes.txt', binaryHeader).kind).toBe('unknown');
  });
});

// ── sniffImageDimensions ──────────────────────────────────────────────
//
// Minimal valid header builders for each supported raster format. Each
// produces just enough bytes for `sniffImageDimensions` to locate the
// dimension fields.

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** PNG IHDR: width/height are big-endian uint32 at offsets 16 and 20. */
function buildPng(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24);
  Buffer.from(PNG_SIGNATURE).copy(buf, 0);
  Buffer.from('IHDR').copy(buf, 12);
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

/** GIF logical-screen: width/height are little-endian uint16 at 6 and 8. */
function buildGif(signature: 'GIF87a' | 'GIF89a', width: number, height: number): Buffer {
  const buf = Buffer.alloc(10);
  Buffer.from(signature, 'latin1').copy(buf, 0);
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

/** BMP DIB header: width/height are little-endian int32 at 18 and 22. */
function buildBmp(width: number, height: number): Buffer {
  const buf = Buffer.alloc(26);
  Buffer.from('BM', 'latin1').copy(buf, 0);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  return buf;
}

/** WebP VP8 (lossy): 14-bit width/height masked from uint16 at 26 and 28. */
function buildWebpVp8(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30);
  Buffer.from('RIFF', 'latin1').copy(buf, 0);
  Buffer.from('WEBP', 'latin1').copy(buf, 8);
  Buffer.from('VP8 ', 'latin1').copy(buf, 12);
  buf.writeUInt16LE(width & 0x3fff, 26);
  buf.writeUInt16LE(height & 0x3fff, 28);
  return buf;
}

/** WebP VP8L (lossless): width-1 / height-1 bit-packed into uint32 at 21. */
function buildWebpVp8l(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30);
  Buffer.from('RIFF', 'latin1').copy(buf, 0);
  Buffer.from('WEBP', 'latin1').copy(buf, 8);
  Buffer.from('VP8L', 'latin1').copy(buf, 12);
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  buf.writeUInt32LE(Math.trunc(bits), 21);
  return buf;
}

/** WebP VP8X (extended): width-1 / height-1 as 24-bit LE at 24 and 27. */
function buildWebpVp8x(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30);
  Buffer.from('RIFF', 'latin1').copy(buf, 0);
  Buffer.from('WEBP', 'latin1').copy(buf, 8);
  Buffer.from('VP8X', 'latin1').copy(buf, 12);
  const w = width - 1;
  const h = height - 1;
  buf[24] = w & 0xff;
  buf[25] = (w >> 8) & 0xff;
  buf[26] = (w >> 16) & 0xff;
  buf[27] = h & 0xff;
  buf[28] = (h >> 8) & 0xff;
  buf[29] = (h >> 16) & 0xff;
  return buf;
}

/**
 * JPEG with one SOF0 frame: SOI marker, an APP0 segment to exercise the
 * segment-skipping loop, then the SOF0 segment carrying height/width as
 * big-endian uint16.
 */
function buildJpeg(width: number, height: number): Buffer {
  const soi = Buffer.from([0xff, 0xd8]);
  // APP0 segment: marker + length(2) + 4 bytes of payload.
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00]);
  // SOF0: marker, length(0x0011=17), precision, height(BE), width(BE), …
  const sof0 = Buffer.alloc(19);
  sof0[0] = 0xff;
  sof0[1] = 0xc0;
  sof0.writeUInt16BE(17, 2);
  sof0[4] = 8; // sample precision
  sof0.writeUInt16BE(height, 5);
  sof0.writeUInt16BE(width, 7);
  return Buffer.concat([soi, app0, sof0]);
}

describe('sniffImageDimensions', () => {
  const cases: ReadonlyArray<{
    name: string;
    data: Buffer;
    expected: ImageDimensions;
  }> = [
    { name: 'PNG (IHDR big-endian uint32)', data: buildPng(800, 600), expected: { width: 800, height: 600 } },
    {
      name: 'GIF87a (logical screen little-endian uint16)',
      data: buildGif('GIF87a', 320, 240),
      expected: { width: 320, height: 240 },
    },
    {
      name: 'GIF89a (logical screen little-endian uint16)',
      data: buildGif('GIF89a', 1024, 768),
      expected: { width: 1024, height: 768 },
    },
    { name: 'BMP (DIB little-endian int32)', data: buildBmp(640, 480), expected: { width: 640, height: 480 } },
    {
      name: 'BMP top-down (negative height → absolute value)',
      data: buildBmp(640, -480),
      expected: { width: 640, height: 480 },
    },
    {
      name: 'WebP VP8 (14-bit masked dimensions)',
      data: buildWebpVp8(256, 192),
      expected: { width: 256, height: 192 },
    },
    {
      name: 'WebP VP8L (bit-packed, stored as value-1)',
      data: buildWebpVp8l(300, 200),
      expected: { width: 300, height: 200 },
    },
    {
      name: 'WebP VP8X (24-bit little-endian, stored as value-1)',
      data: buildWebpVp8x(4000, 3000),
      expected: { width: 4000, height: 3000 },
    },
    {
      name: 'JPEG (SOF0 segment, height before width)',
      data: buildJpeg(1280, 720),
      expected: { width: 1280, height: 720 },
    },
  ];

  it.each(cases)('parses dimensions from $name', ({ data, expected }) => {
    expect(sniffImageDimensions(data)).toEqual(expected);
  });

  it('reads VP8 14-bit masking — values above 0x3fff wrap to the low bits', () => {
    // 14-bit field tops out at 16383; the mask discards higher bits.
    const data = buildWebpVp8(16383, 1);
    expect(sniffImageDimensions(data)).toEqual({ width: 16383, height: 1 });
  });

  it('keeps JPEG height/width order distinct (non-square frame)', () => {
    // A non-square frame proves the SOF0 reader does not transpose axes.
    const data = buildJpeg(100, 700);
    expect(sniffImageDimensions(data)).toEqual({ width: 100, height: 700 });
  });

  describe('truncated / malformed input returns null without throwing', () => {
    const malformed: ReadonlyArray<{ name: string; data: Buffer }> = [
      {
        name: 'PNG header shorter than 24 bytes',
        data: Buffer.from([...PNG_SIGNATURE, 0x00, 0x00, 0x00]),
      },
      {
        name: 'GIF header shorter than 10 bytes',
        data: Buffer.from('GIF89a\0', 'latin1'),
      },
      {
        name: 'BMP header shorter than 26 bytes',
        data: Buffer.concat([Buffer.from('BM', 'latin1'), Buffer.alloc(10)]),
      },
      {
        name: 'WebP RIFF container shorter than 30 bytes',
        data: Buffer.concat([
          Buffer.from('RIFF', 'latin1'),
          Buffer.alloc(4),
          Buffer.from('WEBP', 'latin1'),
          Buffer.from('VP8 ', 'latin1'),
        ]),
      },
      {
        name: 'WebP VP8L chunk shorter than 25 bytes',
        data: (() => {
          const buf = Buffer.alloc(30);
          Buffer.from('RIFF', 'latin1').copy(buf, 0);
          Buffer.from('WEBP', 'latin1').copy(buf, 8);
          Buffer.from('VP8L', 'latin1').copy(buf, 12);
          return buf.subarray(0, 24);
        })(),
      },
      {
        name: 'JPEG with no SOF segment (only SOI + truncated APP0)',
        data: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      },
      {
        name: 'JPEG with an illegal segment length (< 2) before any SOF',
        // SOI then an APP0 marker whose declared length is 0; the
        // `segmentLength < 2` guard must break instead of looping forever.
        data: Buffer.from([
          0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        ]),
      },
      {
        name: 'JPEG SOF marker whose payload runs past the buffer end',
        // SOI + SOF0 marker but the segment body is cut short, so the
        // `offset + 9 < buf.length` guard stops the loop before reading.
        data: Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00]),
      },
      {
        name: 'completely unrecognised bytes',
        data: Buffer.from('not an image at all', 'latin1'),
      },
    ];

    it.each(malformed)('$name', ({ data }) => {
      let result: ImageDimensions | null = null;
      expect(() => {
        result = sniffImageDimensions(data);
      }).not.toThrow();
      expect(result).toBeNull();
    });
  });
});

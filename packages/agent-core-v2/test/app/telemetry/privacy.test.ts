import { describe, expect, it } from 'vitest';

import { cleanTelemetryProperties, cleanTelemetryString } from '#/app/telemetry/privacy';

/**
 * `cleanTelemetryString` is the last step before `CloudAppender.track` buffers an
 * event and `CloudTransport` POSTs it (`cloudAppender.ts:115`), so anything that
 * survives here leaves the machine. The path patterns therefore have to hold for
 * home directories that are not ASCII, and for Windows spellings other than
 * `C:\a\b`.
 */
describe('cleanTelemetryString', () => {
  describe('non-ASCII home directories', () => {
    // `\w` is ASCII-only, so a path pattern built from it stopped at the first
    // non-ASCII byte and left the remainder — user name included — in the payload.
    it('redacts a POSIX path under a CJK home directory', () => {
      expect(cleanTelemetryString('ENOENT: /home/李明/proj/secret.txt')).toBe(
        'ENOENT: <REDACTED: user-file-path>',
      );
    });

    it('redacts a Windows path under a CJK home directory', () => {
      expect(cleanTelemetryString(String.raw`ENOENT: C:\Users\李明\proj\secret.txt`)).toBe(
        'ENOENT: <REDACTED: user-file-path>',
      );
    });

    it('redacts a Cyrillic home directory', () => {
      expect(cleanTelemetryString('/home/иван/proj/secret.txt')).toBe(
        '<REDACTED: user-file-path>',
      );
    });

    it('redacts an accented home directory on both platforms', () => {
      expect(cleanTelemetryString('/home/josé/proj/secret.txt')).toBe(
        '<REDACTED: user-file-path>',
      );
      expect(cleanTelemetryString(String.raw`C:\Users\josé\proj\secret.txt`)).toBe(
        '<REDACTED: user-file-path>',
      );
    });

    it('redacts a name containing an apostrophe', () => {
      expect(cleanTelemetryString(String.raw`C:\Users\O'Brien\proj\secret.txt`)).toBe(
        '<REDACTED: user-file-path>',
      );
    });

    it('redacts a name containing a space', () => {
      expect(cleanTelemetryString('/home/alice chen/proj/secret.txt')).toBe(
        '<REDACTED: user-file-path>',
      );
      expect(cleanTelemetryString(String.raw`C:\Users\alice chen\proj\secret.txt`)).toBe(
        '<REDACTED: user-file-path>',
      );
      expect(cleanTelemetryString(String.raw`C:\Program Files\app\config.json`)).toBe(
        '<REDACTED: user-file-path>',
      );
    });

    it('redacts a filename containing a space', () => {
      // The last segment is where the filename lives, so a space in it must not
      // end the match — that would leave the rest of the name on the wire.
      expect(cleanTelemetryString(String.raw`C:\Users\alice\secret file.txt`)).toBe(
        '<REDACTED: user-file-path>',
      );
      expect(cleanTelemetryString('/home/alice/proj/secret file.txt')).toBe(
        '<REDACTED: user-file-path>',
      );
      expect(cleanTelemetryString(String.raw`\\fileserver\home\secret file.txt`)).toBe(
        '<REDACTED: user-file-path>',
      );
      expect(cleanTelemetryString(String.raw`C:\Users\alice\my report v2.final.docx`)).toBe(
        '<REDACTED: user-file-path>',
      );
    });

    it('stops a space-tolerant final segment at the path, not mid-sentence', () => {
      // A space may continue the final segment only when what follows it still
      // ends in an extension. Trailing prose does not, so the match backtracks
      // to the filename instead of swallowing the sentence.
      expect(cleanTelemetryString(String.raw`C:\Program Files\a.txt could not be read`)).toBe(
        '<REDACTED: user-file-path> could not be read',
      );
      expect(cleanTelemetryString('/home/alice chen/proj/a.txt could not be read')).toBe(
        '<REDACTED: user-file-path> could not be read',
      );
      expect(cleanTelemetryString(String.raw`C:\proj\a.txt failed at step 2.5`)).toBe(
        '<REDACTED: user-file-path> failed at step 2.5',
      );
    });
  });

  describe('Windows path spellings', () => {
    it('redacts a UNC share path', () => {
      // Matched neither the drive-letter pattern nor the POSIX one, so it passed
      // through with the share name and the whole path intact.
      const cleaned = cleanTelemetryString(
        String.raw`ENOENT: \\fileserver\home\alice.chen\proj\secret.txt`,
      );
      expect(cleaned).toBe('ENOENT: <REDACTED: user-file-path>');
      expect(cleaned).not.toContain('fileserver');
      expect(cleaned).not.toContain('alice.chen');
    });

    it('redacts the \\\\?\\ long-path form', () => {
      const cleaned = cleanTelemetryString(
        String.raw`ENOENT: \\?\C:\Users\alice.chen\proj\secret.txt`,
      );
      expect(cleaned).not.toContain('alice.chen');
      expect(cleaned).not.toContain('secret.txt');
    });

    it('redacts a drive-letter path written with forward slashes', () => {
      // Node and many libraries normalize to `C:/...`; the drive letter used to
      // survive as a stray `C:` before the placeholder.
      expect(cleanTelemetryString('ENOENT: C:/Users/alice.chen/proj/secret.txt')).toBe(
        'ENOENT: <REDACTED: user-file-path>',
      );
    });

    it('redacts a path at the drive root', () => {
      expect(cleanTelemetryString(String.raw`ENOENT: C:\alice-secrets.txt`)).toBe(
        'ENOENT: <REDACTED: user-file-path>',
      );
    });
  });

  describe('behaviour that must not regress', () => {
    it('still redacts plain ASCII paths on both platforms', () => {
      expect(cleanTelemetryString(String.raw`ENOENT: C:\Users\alice.chen\proj\secret.txt`)).toBe(
        'ENOENT: <REDACTED: user-file-path>',
      );
      expect(cleanTelemetryString('ENOENT: /home/alice.chen/proj/secret.txt')).toBe(
        'ENOENT: <REDACTED: user-file-path>',
      );
    });

    it('keeps the node_modules tail, which carries diagnostic value', () => {
      expect(cleanTelemetryString('/home/alice.chen/repo/node_modules/pkg/index.js')).toBe(
        'node_modules/pkg/index.js',
      );
    });

    it('keeps the node_modules tail on Windows too', () => {
      // The marker is spelled with a forward slash, so a backslash path never
      // matched it and the diagnostic tail was thrown away.
      expect(
        cleanTelemetryString(String.raw`C:\Users\alice.chen\repo\node_modules\pkg\index.js`),
      ).toBe('node_modules/pkg/index.js');
    });

    it('leaves consecutive fractions alone', () => {
      // A space-tolerant segment lets `2 then 3` read as one segment, so without
      // the alphanumeric lookbehind the run from `/2` to `/6` matches as a path.
      expect(cleanTelemetryString('read 1/2 then 3/4 then 5/6')).toBe(
        'read 1/2 then 3/4 then 5/6',
      );
      expect(cleanTelemetryString('ratio 1/2 and 3/4')).toBe('ratio 1/2 and 3/4');
    });

    it('still redacts a two-segment absolute path', () => {
      expect(cleanTelemetryString('/tmp/kimi-scratch.json')).toBe('<REDACTED: user-file-path>');
      expect(cleanTelemetryString('/etc/passwd')).toBe('<REDACTED: user-file-path>');
    });

    it('leaves text that is not an absolute path alone', () => {
      expect(cleanTelemetryString('read 3/4 of the file')).toBe('read 3/4 of the file');
      expect(cleanTelemetryString('the operation timed out after 30s')).toBe(
        'the operation timed out after 30s',
      );
      expect(cleanTelemetryString('/tmp')).toBe('/tmp');
      expect(cleanTelemetryString('moonshotai/kimi-k2-instruct')).toBe(
        'moonshotai/kimi-k2-instruct',
      );
      expect(cleanTelemetryString('')).toBe('');
    });

    it('still applies the labeled patterns', () => {
      expect(cleanTelemetryString('mail alice@example.com')).toBe('mail <REDACTED: Email>');
      expect(cleanTelemetryString('see https://example.com/a/b')).toBe('see <REDACTED: URL>');
      expect(cleanTelemetryString('key sk-abcdefghijklmnopqrstuv')).toBe(
        'key <REDACTED: API Key>',
      );
    });

    it('does not let the path pattern consume an earlier placeholder', () => {
      // The URL is replaced first; the path pass must not then treat the
      // placeholder or its surroundings as a path.
      expect(
        cleanTelemetryString('GET https://api.example.com/v1/x failed for /home/alice/p/s.txt'),
      ).toBe('GET <REDACTED: URL> failed for <REDACTED: user-file-path>');
      expect(cleanTelemetryString('alice@example.com opened /home/alice/p/s.txt')).toBe(
        '<REDACTED: Email> opened <REDACTED: user-file-path>',
      );
    });

    it('redacts every path in a value, not just the first', () => {
      expect(cleanTelemetryString('copy /home/alice/a.txt to /home/alice/b.txt')).toBe(
        'copy <REDACTED: user-file-path> to <REDACTED: user-file-path>',
      );
    });

    it('does not leak across repeated calls', () => {
      // The patterns are module-level `/g` literals; `replace` resets `lastIndex`
      // but `exec`/`test` would not, so pin the behaviour callers rely on.
      const input = '/home/李明/proj/secret.txt';
      expect(cleanTelemetryString(input)).toBe('<REDACTED: user-file-path>');
      expect(cleanTelemetryString(input)).toBe('<REDACTED: user-file-path>');
      expect(cleanTelemetryString(input)).toBe('<REDACTED: user-file-path>');
    });
  });
});

describe('cleanTelemetryProperties', () => {
  it('cleans string values and passes other primitives through', () => {
    expect(
      cleanTelemetryProperties({
        cwd: '/home/李明/proj',
        count: 3,
        ok: true,
        missing: undefined,
        empty: null,
      }),
    ).toEqual({
      cwd: '<REDACTED: user-file-path>',
      count: 3,
      ok: true,
      missing: undefined,
      empty: null,
    });
  });
});

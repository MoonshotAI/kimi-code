import { describe, expect, it } from 'vitest';

import { cleanTelemetryProperties, cleanTelemetryString } from '#/app/telemetry/privacy';

const REDACTED = '<REDACTED: user-file-path>';

describe('cleanTelemetryString (absolute path redaction)', () => {
  it('redacts ASCII POSIX and Windows paths', () => {
    expect(cleanTelemetryString('/home/alice/proj/x.txt')).toBe(REDACTED);
    expect(cleanTelemetryString('C:\\Users\\alice\\proj\\x.txt')).toBe(REDACTED);
  });

  it('redacts POSIX paths whose home directory is non-ASCII', () => {
    expect(cleanTelemetryString('/home/李明/proj/secret.txt')).toBe(REDACTED);
    expect(cleanTelemetryString('/home/иван/proj/secret.txt')).toBe(REDACTED);
    expect(cleanTelemetryString('/home/josé/proj/secret.txt')).toBe(REDACTED);
    expect(cleanTelemetryString('/home/alice/秘密🔒/secret.txt')).toBe(REDACTED);
    expect(cleanTelemetryString('/home/alice,smith/project/secret.txt')).toBe(REDACTED);
  });

  it('redacts Windows paths whose user folder is non-ASCII or contains an apostrophe', () => {
    expect(cleanTelemetryString('C:\\Users\\李明\\proj\\secret.txt')).toBe(REDACTED);
    expect(cleanTelemetryString('C:\\Users\\josé\\proj\\secret.txt')).toBe(REDACTED);
    expect(cleanTelemetryString("C:\\Users\\O'Brien\\proj\\secret.txt")).toBe(REDACTED);
  });

  it('redacts decomposed Unicode path segments including combining marks', () => {
    expect(cleanTelemetryString('C:\\Users\\jose\u0301\\proj\\secret.txt')).toBe(REDACTED);
    expect(cleanTelemetryString('/home/jose\u0301/proj/secret.txt')).toBe(REDACTED);
  });

  it('redacts spaces in final filenames without swallowing diagnostic text', () => {
    expect(cleanTelemetryString('C:\\Users\\alice\\Secret File.txt could not be read')).toBe(
      `${REDACTED} could not be read`,
    );
    expect(cleanTelemetryString('/home/alice/Secret File.txt could not be read')).toBe(
      `${REDACTED} could not be read`,
    );
  });

  it('redacts a trailing spaced directory when its separator marks the boundary', () => {
    expect(cleanTelemetryString('C:\\Users\\alice\\Secret Folder\\')).toBe(REDACTED);
    expect(cleanTelemetryString('/home/alice/Secret Folder/')).toBe(REDACTED);
  });

  it('redacts extensionless spaced final path components', () => {
    expect(cleanTelemetryString('C:\\Users\\alice\\Secret Folder')).toBe(REDACTED);
    expect(cleanTelemetryString('/home/alice/Secret Folder')).toBe(REDACTED);
    expect(cleanTelemetryString('C:\\Users\\Alice  Smith\\project\\secret.txt')).toBe(REDACTED);
  });

  it('redacts UNC and long-path Windows spellings', () => {
    expect(cleanTelemetryString('\\\\fileserver\\home\\alice.chen\\proj\\secret.txt')).toBe(
      REDACTED,
    );
    expect(cleanTelemetryString('\\\\?\\C:\\Users\\alice\\proj\\secret.txt')).toBe(REDACTED);
    expect(cleanTelemetryString('\\\\?\\UNC\\fileserver\\home\\alice\\proj\\secret.txt')).toBe(
      REDACTED,
    );
    expect(cleanTelemetryString('\\\\server\\Shared Files\\alice\\secret.txt')).toBe(REDACTED);
    expect(cleanTelemetryString('\\\\?\\UNC\\server\\Shared Files\\alice\\secret.txt')).toBe(
      REDACTED,
    );
    expect(cleanTelemetryString('\\\\server/share\\alice\\secret.txt')).toBe(REDACTED);
    expect(cleanTelemetryString('\\\\fileserver\\alice')).toBe(REDACTED);
    expect(cleanTelemetryString('\\\\fileserver\\alice\\')).toBe(REDACTED);
    expect(cleanTelemetryString('\\\\server\\C$\\Users\\alice\\secret.txt')).toBe(REDACTED);
    expect(cleanTelemetryString('\\\\server\\team#1\\alice\\secret.txt')).toBe(REDACTED);
    expect(cleanTelemetryString('\\\\server\\share\\alice#1\\secret.txt')).toBe(REDACTED);
    expect(cleanTelemetryString('\\\\?\\C:\\Users\\alice\\Secret \\file.txt')).toBe(REDACTED);
  });

  it('redacts Win32 device-drive paths without leaving their tails', () => {
    expect(cleanTelemetryString(String.raw`\\.\C:\Users\alice\secret.txt`)).toBe(REDACTED);
    expect(cleanTelemetryString(String.raw`\\.\C:\Users\alice\cache`)).toBe(REDACTED);
  });

  it('redacts mixed-separator Windows device prefixes before UNC roots', () => {
    for (const prefix of ['//.\\', '/\\.\\', '\\/.\\', '//./', '//?\\']) {
      expect(cleanTelemetryString(prefix + String.raw`C:\Users\alice\secret.txt`)).toBe(REDACTED);
      expect(cleanTelemetryString(prefix + String.raw`C:\Users\alice\cache`)).toBe(REDACTED);
    }
  });

  it('splits shell-delimited drive paths without exposing the second path', () => {
    for (const separator of ['&&', '&', '||', '|', ';']) {
      expect(cleanTelemetryString(String.raw`C:\a\cache` + separator + String.raw`C:\Users\bob\private`)).toBe(
        `${REDACTED}${separator}${REDACTED}`,
      );
      expect(cleanTelemetryString(String.raw`C:\a\node_modules\pkg` + separator + String.raw`D:\Users\bob\private`)).toBe(
        `node_modules/pkg${separator}${REDACTED}`,
      );
    }
    expect(cleanTelemetryString(String.raw`C:\Users\alice\a&&b\secret.txt`)).toBe(REDACTED);
  });

  it('splits shell-delimited POSIX paths before preserving dependency tails', () => {
    for (const separator of [';', '&&', '&', '||', '|']) {
      expect(cleanTelemetryString('/home/alice/node_modules/pkg' + separator + '/home/bob/private')).toBe(
        `node_modules/pkg${separator}${REDACTED}`,
      );
      expect(cleanTelemetryString('/home/alice/cache' + separator + '/home/bob/private')).toBe(
        `${REDACTED}${separator}${REDACTED}`,
      );
    }
    expect(cleanTelemetryString('/home/alice/a;b&&c/secret.txt')).toBe(REDACTED);
  });

  it('redacts POSIX paths with repeated separators', () => {
    expect(cleanTelemetryString('/home/alice//secret.txt')).toBe(REDACTED);
    expect(cleanTelemetryString('/home/alice/secret.txt//')).toBe(REDACTED);
    expect(cleanTelemetryString('//home///alice//cache///')).toBe(REDACTED);
    expect(cleanTelemetryString('failed at /home//alice/cache///: permission denied')).toBe(
      `failed at ${REDACTED}: permission denied`,
    );
  });

  it('preserves diagnostics after single-quoted extensionless Windows paths', () => {
    expect(
      cleanTelemetryString(String.raw`failure at 'C:\Users\alice\cache' could not be read`),
    ).toBe(`failure at '${REDACTED}' could not be read`);
    expect(
      cleanTelemetryString(String.raw`failure at 'C:\Users\O'Brien\cache' could not be read`),
    ).toBe(`failure at '${REDACTED}' could not be read`);
    expect(cleanTelemetryString(String.raw`C:\Users\O'Brien\cache`)).toBe(REDACTED);
    expect(cleanTelemetryString(String.raw`C:\Users\O' Brien\cache`)).toBe(REDACTED);
    expect(
      cleanTelemetryString(String.raw`failure at 'C:\Users\alice\cache' couldn't be read`),
    ).toBe(`failure at '${REDACTED}' couldn't be read`);
  });

  it('keeps Windows paths whole across repeated separators and extension-like components', () => {
    expect(cleanTelemetryString(String.raw`C:\Users\alice\\project\secret.txt`)).toBe(REDACTED);
    expect(cleanTelemetryString(String.raw`C:\Users\alice\\cache\\`)).toBe(REDACTED);
    expect(cleanTelemetryString(String.raw`C:\Users\alice\archive.txt files\secret`)).toBe(
      REDACTED,
    );
    expect(cleanTelemetryString(String.raw`opened C:\Users\alice\a.txt and more`)).toBe(
      `opened ${REDACTED} and more`,
    );
  });

  it('redacts multiword Windows components after an extension-like prefix', () => {
    expect(cleanTelemetryString(String.raw`C:\Users\alice\archive.txt files here\secret`)).toBe(REDACTED);
    expect(cleanTelemetryString(String.raw`C:\Users\alice\archive.txt files here\secret.txt`)).toBe(REDACTED);
  });

  it('splits adjacent drive paths and keeps comma diagnostics on extensionless paths', () => {
    expect(cleanTelemetryString(String.raw`C:\Users\alice\bin;C:\Users\bob\bin`)).toBe(
      `${REDACTED};${REDACTED}`,
    );
    expect(cleanTelemetryString(String.raw`C:\Users\alice\bin; D:\Users\bob\bin`)).toBe(
      `${REDACTED}; ${REDACTED}`,
    );
    expect(cleanTelemetryString(String.raw`C:\a\node_modules\pkg;C:\Users\bob\secret`)).toBe(
      `node_modules/pkg;${REDACTED}`,
    );
    expect(cleanTelemetryString(String.raw`C:\Users\alice\file;name.txt`)).toBe(REDACTED);
    expect(cleanTelemetryString(String.raw`failed at C:\Users\alice\cache, retrying now`)).toBe(
      `failed at ${REDACTED}, retrying now`,
    );
    expect(
      cleanTelemetryString(String.raw`failure at 'C:\Users\alice\bin;C:\Users\bob\bin' done`),
    ).toBe(`failure at '${REDACTED};${REDACTED}' done`);
  });

  it('splits colon-delimited POSIX paths before preserving dependency tails', () => {
    expect(cleanTelemetryString('/home/alice/app/node_modules/pkg:/home/bob/private')).toBe(
      `node_modules/pkg:${REDACTED}`,
    );
    expect(cleanTelemetryString('/home/alice/cache:/home/bob/private')).toBe(`${REDACTED}:${REDACTED}`);
    expect(cleanTelemetryString('/home/alice/node_modules/pkg,/tmp/log')).toBe(
      `node_modules/pkg,${REDACTED}`,
    );
    expect(cleanTelemetryString('/home/alice/foo:bar/secret.txt')).toBe(REDACTED);
    expect(cleanTelemetryString('/home/alice/a.txt:/home/bob/b.txt')).toBe(`${REDACTED}:${REDACTED}`);
  });

  it('redacts consecutive Windows drive paths without consuming the next drive letter', () => {
    expect(cleanTelemetryString(String.raw`C:\Users\alice\cache, see C:\Users\bob\log`)).toBe(
      `${REDACTED}, see ${REDACTED}`,
    );
    expect(cleanTelemetryString(String.raw`C:\Users\alice\cache see D:\Users\bob\log`)).toBe(
      `${REDACTED} ${REDACTED}`,
    );
    expect(cleanTelemetryString(String.raw`C:\Users\alice, smith\secret.txt`)).toBe(REDACTED);
  });

  it('redacts extensionless POSIX paths separated by prose', () => {
    expect(cleanTelemetryString('open /home/alice/cache see /tmp/log')).toBe(`open ${REDACTED}`);
    expect(cleanTelemetryString('open /home/alice/node_modules/pkg see /tmp/log')).toBe(`open ${REDACTED}`);
  });

  it('redacts POSIX components ending in spaces', () => {
    expect(cleanTelemetryString('/home/alice/private /secret.txt')).toBe(REDACTED);
    expect(cleanTelemetryString('/home/alice/private /cache')).toBe(REDACTED);
  });

  it('redacts UNC paths with forward-slash and mixed leading separators', () => {
    expect(cleanTelemetryString(String.raw`//server\share\alice\secret.txt`)).toBe(REDACTED);
    expect(cleanTelemetryString(String.raw`/\server\share\alice\cache`)).toBe(REDACTED);
    expect(cleanTelemetryString(String.raw`\/server\share\alice\cache`)).toBe(REDACTED);
    expect(cleanTelemetryString(String.raw`//server\share\alice\NODE_MODULES\pkg\index.js`)).toBe(
      'NODE_MODULES/pkg/index.js',
    );
    expect(cleanTelemetryString('//home/alice/NODE_MODULES/private-project/secret.js')).toBe(REDACTED);
  });

  it('preserves diagnostics after backtick-delimited paths', () => {
    expect(cleanTelemetryString('failed at `/home/alice/file.txt` could not be read')).toBe(
      `failed at \`${REDACTED}\` could not be read`,
    );
    expect(cleanTelemetryString('failed at `C:\\Users\\alice\\cache` could not be read')).toBe(
      `failed at \`${REDACTED}\` could not be read`,
    );
  });

  it('redacts long whitespace components without excessive backtracking', () => {
    const started = performance.now();
    expect(cleanTelemetryString(String.raw`C:\Users\alice` + '/' + ' '.repeat(3000) + 'x')).toBe(REDACTED);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('preserves diagnostics after single-quoted extensionless POSIX paths', () => {
    expect(cleanTelemetryString(`failure at '/home/alice/cache' could not be read`)).toBe(
      `failure at '${REDACTED}' could not be read`,
    );
    expect(cleanTelemetryString(`/home/o'brien/cache`)).toBe(REDACTED);
  });

  it('redacts drive-letter paths spelled with forward slashes', () => {
    expect(cleanTelemetryString('C:/Users/alice.chen/proj/secret.txt')).toBe(REDACTED);
  });

  it('keeps node_modules tails on POSIX and Windows', () => {
    expect(cleanTelemetryString('/home/alice/app/node_modules/pkg/index.js')).toBe(
      'node_modules/pkg/index.js',
    );
    expect(cleanTelemetryString('C:\\Users\\alice\\app\\node_modules\\pkg\\index.js')).toBe(
      'node_modules/pkg/index.js',
    );
    expect(cleanTelemetryString('/home/alice/NODE_MODULES/private-project/secret.js')).toBe(
      REDACTED,
    );
    expect(cleanTelemetryString('C:\\Users\\alice-node_modules\\private\\secret.txt')).toBe(
      REDACTED,
    );
  });

  it('redacts dependency tails containing another drive or parent traversal', () => {
    expect(cleanTelemetryString(String.raw`/home/alice/node_modules/pkg\C:\Users\bob\private`)).toBe(REDACTED);
    expect(cleanTelemetryString(String.raw`C:\Users\alice\node_modules\pkg\..\..\Users\bob\secret`)).toBe(REDACTED);
    expect(cleanTelemetryString('/home/alice/node_modules/pkg/../../private')).toBe(REDACTED);
    expect(cleanTelemetryString('/home/alice/node_modules/pkg/..cache/index.js')).toBe('node_modules/pkg/..cache/index.js');
  });

  it('does not swallow trailing diagnostic text after a spaced Windows path', () => {
    expect(cleanTelemetryString('C:\\Program Files\\a.txt could not be read')).toBe(
      `${REDACTED} could not be read`,
    );
    expect(cleanTelemetryString("failure at '/home/alice/file.txt' could not be read")).toBe(
      `failure at '${REDACTED}' could not be read`,
    );
    expect(cleanTelemetryString('failure at C:\\Users\\alice\\file.txt, retrying now')).toBe(
      `failure at ${REDACTED}, retrying now`,
    );
    expect(cleanTelemetryString('failure at /home/alice/file.txt, retrying now')).toBe(
      `failure at ${REDACTED}, retrying now`,
    );
    expect(cleanTelemetryString('failed at C:\\Users\\alice\\cache: permission denied')).toBe(
      `failed at ${REDACTED}: permission denied`,
    );
    expect(cleanTelemetryString('failed at C:\\Users\\alice\\cache\npermission denied')).toBe(
      `failed at ${REDACTED}\npermission denied`,
    );
  });

  it('redacts each POSIX path separately and stops at diagnostic boundaries', () => {
    expect(cleanTelemetryString('open /home/a/x.txt, see /tmp/log.txt')).toBe(
      `open ${REDACTED}, see ${REDACTED}`,
    );
    expect(cleanTelemetryString('open /home/a/x.txt see /tmp/log.txt')).toBe(
      `open ${REDACTED} see ${REDACTED}`,
    );
    expect(cleanTelemetryString('failed at /home/alice/cache: permission denied')).toBe(
      `failed at ${REDACTED}: permission denied`,
    );
    expect(cleanTelemetryString('failed at /home/alice/cache, retrying now')).toBe(
      `failed at ${REDACTED}, retrying now`,
    );
    expect(cleanTelemetryString('failed at /home/alice/cache\npermission denied')).toBe(
      `failed at ${REDACTED}\npermission denied`,
    );
  });

  it('leaves non-path text alone', () => {
    expect(cleanTelemetryString('edit failed: missing old_string')).toBe(
      'edit failed: missing old_string',
    );
  });

  it('bounds synchronous cleaning for oversized telemetry strings', () => {
    expect(cleanTelemetryString(`/home/${'a.'.repeat(30_000)}x`)).toBe(
      '<REDACTED: oversized telemetry-string>',
    );
  });

  it('still redacts emails and URLs before paths', () => {
    expect(cleanTelemetryString('user@example.com')).toBe('<REDACTED: Email>');
    expect(cleanTelemetryString('see https://example.com/a/b for details')).toBe(
      'see <REDACTED: URL> for details',
    );
  });
});

describe('cleanTelemetryProperties', () => {
  it('redacts string values and leaves non-strings untouched', () => {
    expect(
      cleanTelemetryProperties({
        path: '/home/李明/proj/secret.txt',
        count: 3,
        ok: true,
      }),
    ).toEqual({
      path: REDACTED,
      count: 3,
      ok: true,
    });
  });
});

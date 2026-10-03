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
    expect(cleanTelemetryString('\\\\fileserver\\home\\alice.chen\\proj\\secret.txt')).toBe(REDACTED);
    expect(cleanTelemetryString('\\\\?\\C:\\Users\\alice\\proj\\secret.txt')).toBe(REDACTED);
    expect(cleanTelemetryString('\\\\?\\UNC\\fileserver\\home\\alice\\proj\\secret.txt')).toBe(
      REDACTED,
    );
    expect(cleanTelemetryString('\\\\server\\Shared Files\\alice\\secret.txt')).toBe(REDACTED);
    expect(cleanTelemetryString('\\\\?\\UNC\\server\\Shared Files\\alice\\secret.txt')).toBe(
      REDACTED,
    );
    expect(cleanTelemetryString('\\\\fileserver\\alice')).toBe(REDACTED);
    expect(cleanTelemetryString('\\\\fileserver\\alice\\')).toBe(REDACTED);
    expect(cleanTelemetryString('\\\\server\\C$\\Users\\alice\\secret.txt')).toBe(REDACTED);
    expect(cleanTelemetryString('\\\\server\\team#1\\alice\\secret.txt')).toBe(REDACTED);
    expect(cleanTelemetryString('\\\\server\\share\\alice#1\\secret.txt')).toBe(REDACTED);
    expect(cleanTelemetryString('\\\\?\\C:\\Users\\alice\\Secret \\file.txt')).toBe(REDACTED);
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

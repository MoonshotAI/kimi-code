/**
 * Native tools integration tests — real file I/O against the Rust addon.
 *
 * These tests verify that the Rust native tools work correctly with
 * actual filesystem operations, not just in-memory mocks.
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, afterAll } from 'vitest';

// Load the native module
const native = require('../index');

// ── Test helpers ───────────────────────────────────────────────────────────

let tempDir: string;

function setup(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'native-tools-test-'));
  return tempDir;
}

function cleanup() {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function writeTestFile(name: string, content: string): string {
  const path = join(tempDir, name);
  writeFileSync(path, content, 'utf-8');
  return path;
}

// ── Sensitive file detection tests ────────────────────────────────────────

describe('nativeIsSensitiveFile', () => {
  it('detects .env files', () => {
    expect(native.nativeIsSensitiveFile('/project/.env')).toBe(true);
    expect(native.nativeIsSensitiveFile('/project/.env.production')).toBe(true);
    expect(native.nativeIsSensitiveFile('/project/.env.example')).toBe(false);
    expect(native.nativeIsSensitiveFile('/project/.env.sample')).toBe(false);
  });

  it('detects SSH private keys', () => {
    expect(native.nativeIsSensitiveFile('/home/user/.ssh/id_rsa')).toBe(true);
    expect(native.nativeIsSensitiveFile('/home/user/.ssh/id_ed25519')).toBe(true);
    // Public keys are allowed
    expect(native.nativeIsSensitiveFile('/home/user/.ssh/id_rsa.pub')).toBe(false);
  });

  it('detects credentials files', () => {
    expect(native.nativeIsSensitiveFile('/home/user/.aws/credentials')).toBe(true);
    expect(native.nativeIsSensitiveFile('/home/user/.ssh/config')).toBe(true);
    expect(native.nativeIsSensitiveFile('/project/.git-credentials')).toBe(true);
  });

  it('detects keyfile extensions', () => {
    expect(native.nativeIsSensitiveFile('/certs/server.p12')).toBe(true);
    expect(native.nativeIsSensitiveFile('/certs/domain.pfx')).toBe(true);
    expect(native.nativeIsSensitiveFile('/certs/truststore.jks')).toBe(true);
  });

  it('allows normal project files', () => {
    expect(native.nativeIsSensitiveFile('/project/src/main.ts')).toBe(false);
    expect(native.nativeIsSensitiveFile('/project/package.json')).toBe(false);
    expect(native.nativeIsSensitiveFile('/project/README.md')).toBe(false);
  });
});

// ── Path canonicalization tests ───────────────────────────────────────────

describe('nativePathCanonicalize', () => {
  it('resolves relative paths', () => {
    const result = native.nativePathCanonicalize('./src/main.ts', '/workspace/project', 'posix');
    expect(result).toBe('/workspace/project/src/main.ts');
  });

  it('resolves dotdot paths', () => {
    const result = native.nativePathCanonicalize('foo/../../bar', '/workspace/project', 'posix');
    expect(result).toBe('/workspace/bar');
  });

  it('keeps absolute paths unchanged', () => {
    const result = native.nativePathCanonicalize('/absolute/path/file.txt', '/workspace', 'posix');
    expect(result).toBe('/absolute/path/file.txt');
  });
});

describe('nativePathIsWithinDirectory', () => {
  it('detects containment', () => {
    expect(
      native.nativePathIsWithinDirectory(
        '/workspace/project/src/main.ts',
        '/workspace/project',
        'posix',
      ),
    ).toBe(true);
  });

  it('rejects escape attempts', () => {
    expect(
      native.nativePathIsWithinDirectory('/workspace-evil/file.txt', '/workspace', 'posix'),
    ).toBe(false);
  });

  it('rejects sibling paths', () => {
    expect(native.nativePathIsWithinDirectory('/workspace2/file.txt', '/workspace', 'posix')).toBe(
      false,
    );
  });
});

// ── Native Read tests (real file I/O) ────────────────────────────────────

describe('nativeRead', () => {
  setup();

  afterAll(() =>{  cleanup(); });

  it('reads a small file with line numbers', async () => {
    const dir = setup();
    const path = writeTestFile('small.txt', 'line1\nline2\nline3\n');
    const result = await native.nativeRead(path, null, null);
    expect(result.error).toBeNull();
    expect(result.content).toContain('1\tline1');
    expect(result.content).toContain('2\tline2');
    expect(result.content).toContain('3\tline3');
    expect(result.lineCount).toBe(3);
    cleanup();
  });

  it('reads a specific range of lines', async () => {
    const dir = setup();
    const path = writeTestFile('range.txt', 'line1\nline2\nline3\nline4\nline5\n');
    const result = await native.nativeRead(path, 2, 2);
    expect(result.error).toBeNull();
    expect(result.content).toContain('2\tline2');
    expect(result.content).toContain('3\tline3');
    expect(result.content).not.toContain('line1');
    expect(result.content).not.toContain('line4');
    cleanup();
  });

  it('reads the last N lines with negative offset', async () => {
    const dir = setup();
    const path = writeTestFile('tail.txt', 'line1\nline2\nline3\nline4\nline5\n');
    const result = await native.nativeRead(path, -3, null);
    expect(result.error).toBeNull();
    expect(result.content).toContain('3\tline3');
    expect(result.content).toContain('4\tline4');
    expect(result.content).toContain('5\tline5');
    expect(result.content).not.toContain('line1');
    cleanup();
  });

  it('returns error for nonexistent file', async () => {
    const result = await native.nativeRead('/nonexistent/path/file.txt', null, null);
    expect(result.error).not.toBeNull();
    expect(result.error).toBeTruthy();
  });
});

// ── Native Grep tests (real file I/O) ────────────────────────────────────

describe('nativeGrep', () => {
  setup();

  afterAll(() =>{  cleanup(); });

  it('finds matching lines in a file', async () => {
    const dir = setup();
    writeTestFile('search.txt', 'hello world\nfoo bar\nhello again\nbaz qux\n');
    const result = await native.nativeGrep(
      'hello',
      'content',
      false,
      true,
      dir,
      null,
      null,
      0,
      0,
      0,
      250,
      0,
      false,
      5000,
    );
    expect(result.error).toBeNull();
    expect(result.matchCount).toBe(2);
    expect(result.content).toContain('hello world');
    expect(result.content).toContain('hello again');
    cleanup();
  });

  it('performs case-insensitive search', async () => {
    const dir = setup();
    writeTestFile('case.txt', 'Hello World\nfoo bar\nHELLO again\n');
    const result = await native.nativeGrep(
      'hello',
      'content',
      true,
      true,
      dir,
      null,
      null,
      0,
      0,
      0,
      250,
      0,
      false,
      5000,
    );
    expect(result.error).toBeNull();
    expect(result.matchCount).toBe(2);
    cleanup();
  });

  it('returns files_with_matches mode', async () => {
    const dir = setup();
    const path = writeTestFile('files.txt', 'match me\nno match here\n');
    const result = await native.nativeGrep(
      'match',
      'files_with_matches',
      false,
      true,
      dir,
      null,
      null,
      0,
      0,
      0,
      250,
      0,
      false,
      5000,
    );
    expect(result.error).toBeNull();
    expect(result.fileCount).toBe(1);
    cleanup();
  });

  it('returns empty for no matches', async () => {
    const dir = setup();
    writeTestFile('nomatch.txt', 'nothing here\n');
    const result = await native.nativeGrep(
      'zzzzz',
      'content',
      false,
      true,
      dir,
      null,
      null,
      0,
      0,
      0,
      250,
      0,
      false,
      5000,
    );
    expect(result.error).toBeNull();
    expect(result.matchCount).toBe(0);
    cleanup();
  });
});

// ── Permission rule parsing tests ─────────────────────────────────────────

describe('nativeParsePermissionPattern', () => {
  it('parses tool name only', () => {
    const result = JSON.parse(native.nativeParsePermissionPattern('Write'));
    expect(result.toolName).toBe('Write');
    expect(result.argPattern).toBeUndefined();
  });

  it('parses tool with args pattern', () => {
    const result = JSON.parse(native.nativeParsePermissionPattern('Read(/etc/**)'));
    expect(result.toolName).toBe('Read');
    expect(result.argPattern).toBe('/etc/**');
  });

  it('handles empty args', () => {
    const result = JSON.parse(native.nativeParsePermissionPattern('Tool()'));
    expect(result.toolName).toBe('Tool');
    expect(result.argPattern).toBeUndefined();
  });
});

describe('nativeMatchPermissionRule', () => {
  it('matches exact tool name', () => {
    const rule = JSON.stringify({ pattern: 'Read' });
    const result = JSON.parse(native.nativeMatchPermissionRule(rule, 'Read', false, null));
    expect(result.matched).toBe(true);
    expect(result.strategy).toBe('tool_name_only');
  });

  it('rejects different tool name', () => {
    const rule = JSON.stringify({ pattern: 'Read' });
    const result = JSON.parse(native.nativeMatchPermissionRule(rule, 'Write', false, null));
    expect(result.matched).toBe(false);
  });

  it('matches with args pattern', () => {
    const rule = JSON.stringify({ pattern: 'Read(/etc/**)' });
    const result = JSON.parse(native.nativeMatchPermissionRule(rule, 'Read', true, true));
    expect(result.matched).toBe(true);
    expect(result.strategy).toBe('matches_rule');
  });
});

// ── Token estimation tests ────────────────────────────────────────────────

describe('nativeEstimateTokens', () => {
  it('estimates tokens for a short string', () => {
    const count = native.nativeEstimateTokens('hello world');
    expect(typeof count).toBe('number');
    expect(count).toBeGreaterThan(0);
  });

  it('estimates more tokens for longer text', () => {
    const short = native.nativeEstimateTokens('hello world');
    const long = native.nativeEstimateTokens('hello world '.repeat(100));
    expect(long).toBeGreaterThan(short);
  });
});

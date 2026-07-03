/**
 * Unit tests for {@link resolveCanonicalPath} and {@link assertPathInRoots}.
 *
 * The boundary checker is the security-bearing primitive invoked by
 * {@link AcpKaos} on every file operation: it MUST refuse escapes via
 * symlinks (per ACP `additionalDirectories` RFD), and it MUST handle
 * the "path doesn't yet exist" case for writes to new files. These
 * tests use real files on a `mkdtemp` scratch tree plus real
 * `symlinkSync` to exercise the symlink-escape vector end-to-end —
 * mocking `realpath` would test the mock, not the property we care
 * about.
 */

import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { KaosError } from '@moonshot-ai/kaos';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertPathInRoots,
  resolveCanonicalPath,
  resolveCanonicalRoots,
} from '../src/path-boundary';

let scratch: string;

beforeEach(async () => {
  scratch = await fsp.mkdtemp(path.join(tmpdir(), 'acp-boundary-'));
});

afterEach(async () => {
  await fsp.rm(scratch, { recursive: true, force: true });
});

describe('resolveCanonicalPath', () => {
  it('returns realpath for an existing regular file', async () => {
    const target = path.join(scratch, 'file.txt');
    await fsp.writeFile(target, 'hi');
    const canonical = await resolveCanonicalPath(target);
    expect(canonical).toBe(await fsp.realpath(target));
  });

  it('resolves symlinks in the middle of the path', async () => {
    const real = path.join(scratch, 'real');
    const linkDir = path.join(scratch, 'links');
    await fsp.mkdir(real);
    await fsp.writeFile(path.join(real, 'inside.txt'), 'hi');
    await fsp.mkdir(linkDir);
    await fsp.symlink(real, path.join(linkDir, 'to-real'), 'dir');
    const canonical = await resolveCanonicalPath(path.join(linkDir, 'to-real', 'inside.txt'));
    expect(canonical).toBe(path.join(real, 'inside.txt'));
  });

  it('handles non-existent leaf by anchoring at the deepest existing ancestor', async () => {
    // `scratch` exists; `scratch/newdir/new.txt` does not. After this
    // call we should be anchored at the canonical form of `scratch`
    // with the suffix appended — so a symlink scramble inside
    // `scratch` still gets resolved before the check fires.
    const canonical = await resolveCanonicalPath(path.join(scratch, 'newdir', 'new.txt'));
    expect(canonical.startsWith(await fsp.realpath(scratch) + path.sep)).toBe(true);
    expect(canonical.endsWith(path.join('newdir', 'new.txt'))).toBe(true);
  });

  it('resolves a fully non-existent path by anchoring at the filesystem root', async () => {
    // Walking up the parent chain always hits `/`, which is realpath-
    // able on any unix host. The "no canonical ancestor exists" branch
    // is only reachable on a path whose deepest mountpoint is itself
    // missing — a degenerate case that's effectively impossible to
    // contrive in unit tests. What we CAN verify is the canonical
    // form comes out anchored at `/` with the suffix appended.
    const canonical = await resolveCanonicalPath('/totally/made/up/path.txt');
    expect(canonical).toBe(`/totally/made/up/path.txt`);
  });
});

describe('resolveCanonicalRoots', () => {
  it('realpaths every supplied root preserving order', async () => {
    const a = path.join(scratch, 'a');
    const b = path.join(scratch, 'b');
    await fsp.mkdir(a);
    await fsp.mkdir(b);
    const out = await resolveCanonicalRoots([a, b]);
    expect(out).toEqual([await fsp.realpath(a), await fsp.realpath(b)]);
  });

  it('throws when any root does not exist (fail-closed at session init)', async () => {
    const good = path.join(scratch, 'good');
    const missing = path.join(scratch, 'gone');
    await fsp.mkdir(good);
    await expect(resolveCanonicalRoots([good, missing])).rejects.toBeInstanceOf(KaosError);
  });

  it('returns empty array for empty input', async () => {
    expect(await resolveCanonicalRoots([])).toEqual([]);
  });
});

describe('assertPathInRoots', () => {
  it('accepts a path inside the primary cwd root', async () => {
    const cwd = path.join(scratch, 'cwd');
    await fsp.mkdir(cwd);
    const inner = path.join(cwd, 'inside.txt');
    await fsp.writeFile(inner, 'hi');
    const roots = await resolveCanonicalRoots([cwd]);
    await expect(assertPathInRoots(inner, roots, 'read')).resolves.toBeUndefined();
  });

  it('accepts a path inside an additional directory root', async () => {
    const cwd = path.join(scratch, 'cwd');
    const extra = path.join(scratch, 'extra');
    await fsp.mkdir(cwd);
    await fsp.mkdir(extra);
    const inner = path.join(extra, 'lib', 'x.ts');
    await fsp.mkdir(path.dirname(inner), { recursive: true });
    await fsp.writeFile(inner, 'hi');
    const roots = await resolveCanonicalRoots([cwd, extra]);
    await expect(assertPathInRoots(inner, roots, 'read')).resolves.toBeUndefined();
  });

  it('rejects a path that escapes via a symlinked directory', async () => {
    const cwd = path.join(scratch, 'cwd');
    const outside = path.join(scratch, 'outside');
    await fsp.mkdir(cwd);
    await fsp.mkdir(outside);
    await fsp.writeFile(path.join(outside, 'secret.txt'), 'secret');
    // Plant the trap: cwd/escape -> outside
    await fsp.symlink(outside, path.join(cwd, 'escape'), 'dir');
    const roots = await resolveCanonicalRoots([cwd]);
    await expect(
      assertPathInRoots(path.join(cwd, 'escape', 'secret.txt'), roots, 'read'),
    ).rejects.toBeInstanceOf(KaosError);
  });

  it('rejects a sibling path that merely sounds similar', async () => {
    const cwd = path.join(scratch, 'cwd');
    await fsp.mkdir(cwd);
    const sibling = path.join(scratch, 'cwd-evil', 'leak.txt');
    await fsp.mkdir(path.dirname(sibling), { recursive: true });
    await fsp.writeFile(sibling, 'leak');
    const roots = await resolveCanonicalRoots([cwd]);
    // `scratch/cwd-evil` is NOT inside `scratch/cwd` after canonical
    // resolution (different segment), so the prefix-startsWith check
    // must catch it.
    await expect(assertPathInRoots(sibling, roots, 'read')).rejects.toBeInstanceOf(KaosError);
  });

  it('rejects a write target whose parent is a symlink escape', async () => {
    const cwd = path.join(scratch, 'cwd');
    const outside = path.join(scratch, 'outside');
    await fsp.mkdir(cwd);
    await fsp.mkdir(outside);
    await fsp.symlink(outside, path.join(cwd, 'escape'), 'dir');
    const roots = await resolveCanonicalRoots([cwd]);
    // `cwd/escape/new.txt` doesn't exist yet; assertPathInRoots must
    // anchor at the realpath'd parent (= scratch/outside) and reject.
    await expect(
      assertPathInRoots(path.join(cwd, 'escape', 'new.txt'), roots, 'write'),
    ).rejects.toBeInstanceOf(KaosError);
  });

  it('errors include the operation name in the message', async () => {
    const cwd = path.join(scratch, 'cwd');
    const outside = path.join(scratch, 'outside');
    await fsp.mkdir(cwd);
    await fsp.mkdir(outside);
    await fsp.writeFile(path.join(outside, 'secret.txt'), 's');
    await fsp.symlink(outside, path.join(cwd, 'escape'), 'dir');
    const roots = await resolveCanonicalRoots([cwd]);
    await expect(
      assertPathInRoots(path.join(cwd, 'escape', 'secret.txt'), roots, 'write'),
    ).rejects.toThrow(/write/i);
  });

  it('rejects a fully non-existent path that resolves outside the roots', async () => {
    // The path `/totally/made/up/file.txt` doesn't exist on disk; the
    // canonical-resolve walk anchors at `/` and the result still
    // doesn't fall under `scratch/cwd` — boundary check fires.
    const cwd = path.join(scratch, 'cwd');
    await fsp.mkdir(cwd);
    const roots = await resolveCanonicalRoots([cwd]);
    await expect(
      assertPathInRoots('/totally/made/up/file.txt', roots, 'read'),
    ).rejects.toBeInstanceOf(KaosError);
  });
});

import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { KaosFileExistsError } from '#/errors';
import { LocalKaos } from '#/local';
import { afterEach, beforeEach, describe, expect, it, test } from 'vitest';

// LocalKaos normalizes every path to forward slashes (pathe). Mirror that in
// path assertions so they hold on Windows, where node:path/node:os produce
// backslashes.
const toPosix = (p: string): string => p.replaceAll('\\', '/');

function nodeArgs(code: string): string[] {
  return ['node', '-e', code];
}

describe('LocalKaos', () => {
  let kaos: LocalKaos;
  let tempDir: string;

  beforeEach(async () => {
    kaos = await LocalKaos.create();
    tempDir = toPosix(await realpath(await mkdtemp(join(tmpdir(), 'kaos-test-'))));
    await kaos.chdir(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('pathClass, gethome, getcwd', () => {
    it('should return posix or win32 pathClass', () => {
      const cls = kaos.pathClass();
      if (process.platform === 'win32') {
        expect(cls).toBe('win32');
      } else {
        expect(cls).toBe('posix');
      }
    });

    it('should return the home directory', () => {
      // Python test_local_kaos.py pins `str(gethome()) == str(Path.home())`;
      // asserting length > 0 alone was too weak — a stub returning any
      // non-empty string would pass.
      const home = kaos.gethome();
      expect(home).toBe(toPosix(homedir()));
    });

    it('should return the current working directory', () => {
      const cwd = kaos.getcwd();
      expect(cwd).toBe(tempDir);
    });
  });

  describe('chdir + stat', () => {
    it('should change directory and stat a file', async () => {
      const nested = toPosix(join(tempDir, 'nested'));
      await kaos.mkdir(nested);

      await kaos.chdir(nested);
      expect(kaos.getcwd()).toBe(nested);

      const filePath = join(nested, 'file.txt');
      await kaos.writeText(filePath, 'hello world');

      const statResult = await kaos.stat(filePath);
      expect(statResult.stSize).toBe(Buffer.byteLength('hello world', 'utf-8'));
    });

    it('should reject chdir into a regular file', async () => {
      // chdir must explicitly refuse targets that resolve to non-directories
      // so relative I/O calls after the chdir do not silently treat a file
      // path as a working directory.
      const filePath = join(tempDir, 'not-a-dir.txt');
      await kaos.writeText(filePath, 'content');
      await expect(kaos.chdir(filePath)).rejects.toThrow(/Not a directory/);
    });

    it('should accept backslashes as path separators', async () => {
      const nested = join(tempDir, 'backslash-test');
      await kaos.mkdir(nested);
      const filePath = join(nested, 'file.txt');
      await kaos.writeText(filePath, 'hello');

      // Use backslashes — they should be treated as forward slashes.
      const backslashPath = filePath.replaceAll('/', '\\');
      const statResult = await kaos.stat(backslashPath);
      expect(statResult.stSize).toBe(Buffer.byteLength('hello', 'utf-8'));
    });
  });

  describe('iterdir path normalization', () => {
    it('should produce normalized paths even when the argument has a trailing separator', async () => {
      // Regression: previously, iterdir manually concatenated `resolved + sep
      // + entry`, which produced `//entry` for roots like `/` and `C:\\entry`
      // for Windows drives. Using pathJoin correctly collapses the extra
      // separator.
      await kaos.writeText(join(tempDir, 'file.txt'), 'x');

      const entries: string[] = [];
      // Pass tempDir with an explicit trailing slash to simulate the root
      // edge case without needing a writable filesystem root in the test.
      for await (const entry of kaos.iterdir(tempDir + '/')) {
        entries.push(entry);
      }

      expect(entries).toContain(toPosix(join(tempDir, 'file.txt')));
      // No entry should contain duplicated separators.
      expect(entries.every((e) => !e.includes('//'))).toBe(true);
    });
  });

  describe('iterdir + glob', () => {
    it('should list directory entries and match glob patterns', async () => {
      await kaos.mkdir(join(tempDir, 'alpha'));
      await kaos.writeText(join(tempDir, 'bravo.txt'), 'bravo');
      await kaos.writeText(join(tempDir, 'charlie.TXT'), 'charlie');

      const entries: string[] = [];
      for await (const entry of kaos.iterdir(tempDir)) {
        entries.push(entry);
      }
      const names = entries.map((e) => e.split('/').pop()!);
      expect(new Set(names)).toEqual(new Set(['alpha', 'bravo.txt', 'charlie.TXT']));

      const matched: string[] = [];
      for await (const entry of kaos.glob(tempDir, '*.txt')) {
        matched.push(entry);
      }
      const matchedNames = matched.map((e) => e.split('/').pop()!);
      expect(new Set(matchedNames)).toEqual(new Set(['bravo.txt']));
    });
  });

  describe('glob hidden files', () => {
    it('should include hidden files in glob results', async () => {
      await kaos.writeText(join(tempDir, '.gitlab-ci.yml'), 'stages: [build]');
      await kaos.writeText(join(tempDir, 'config.yml'), 'key: value');

      const matched: string[] = [];
      for await (const entry of kaos.glob(tempDir, '*.yml')) {
        matched.push(entry);
      }
      const names = matched.map((e) => e.split('/').pop()!);
      expect(names).toContain('.gitlab-ci.yml');
      expect(names).toContain('config.yml');
    });

    it('should glob through hidden directories with ** pattern', async () => {
      await kaos.mkdir(join(tempDir, 'src'));
      await kaos.mkdir(join(tempDir, 'src', '.config'));
      await kaos.writeText(join(tempDir, 'src', '.config', 'settings.yml'), 'debug: true');
      await kaos.writeText(join(tempDir, 'src', 'main.ts'), 'pass');

      const deepMatched: string[] = [];
      for await (const entry of kaos.glob(tempDir, 'src/**/*.yml')) {
        deepMatched.push(entry);
      }
      expect(deepMatched.some((p) => p.includes('.config'))).toBe(true);
    });
  });

  describe('readText/writeText', () => {
    it('should write, read, append, and readLines', async () => {
      const filePath = join(tempDir, 'note.txt');

      const written = await kaos.writeText(filePath, 'line1');
      expect(written).toBe('line1'.length);

      const content = await kaos.readText(filePath);
      expect(content).toBe('line1');

      await kaos.writeText(filePath, '\nline2', { mode: 'a' });

      const lines: string[] = [];
      for await (const line of kaos.readLines(filePath)) {
        lines.push(line);
      }
      expect(lines.join('')).toBe('line1\nline2');
    });
  });

  describe('readLines streaming', () => {
    async function collectLines(path: string, options?: Parameters<LocalKaos['readLines']>[1]) {
      const lines: string[] = [];
      for await (const line of kaos.readLines(path, options)) {
        lines.push(line);
      }
      return lines;
    }

    it('preserves content exactly across representative line endings', async () => {
      const fixtures: Array<[string, string]> = [
        ['multiline', 'line1\nline2\nline3\n'],
        ['no trailing newline', 'line1\nline2'],
        ['single line', 'only'],
        ['single newline', '\n'],
        ['empty', ''],
        ['crlf', 'a\r\nb\r\n'],
        ['lone cr', 'a\rB\n'],
      ];
      for (const [name, content] of fixtures) {
        const filePath = join(tempDir, `${name}.txt`);
        await kaos.writeText(filePath, content);
        expect((await collectLines(filePath)).join('')).toBe(content);
      }
    });

    it('preserves multibyte characters and long single lines across chunk boundaries', async () => {
      const filePath = join(tempDir, 'boundary.txt');
      const content = `${'a'.repeat(65535)}😀\n${'x'.repeat(200000)}`;
      await kaos.writeText(filePath, content);
      await expect(collectLines(filePath)).resolves.toEqual([
        `${'a'.repeat(65535)}😀\n`,
        'x'.repeat(200000),
      ]);
    });

    it('preserves U+FEFF at the start of a non-first line', async () => {
      const filePath = join(tempDir, 'bom-line.txt');
      const content = 'a\n\uFEFFb\n';
      await kaos.writeText(filePath, content);
      await expect(collectLines(filePath)).resolves.toEqual(['a\n', '\uFEFFb\n']);
    });

    it('keeps utf16le and hex on the decode-then-split path', async () => {
      const utf16Path = join(tempDir, 'utf16le.txt');
      await kaos.writeBytes(utf16Path, Buffer.from('a\n\u0A41\n', 'utf16le'));
      await expect(collectLines(utf16Path, { encoding: 'utf16le' })).resolves.toEqual([
        'a\n',
        'ੁ\n',
      ]);

      const hexPath = join(tempDir, 'hex.txt');
      await kaos.writeBytes(hexPath, Buffer.from('a\nb'));
      await expect(collectLines(hexPath, { encoding: 'hex' })).resolves.toEqual(['610a62']);
    });

    it('throws lazily when strict UTF-8 errors appear after the first line', async () => {
      const filePath = join(tempDir, 'invalid-after-first-line.txt');
      await kaos.writeBytes(filePath, Buffer.concat([Buffer.from('ok\n', 'utf-8'), Buffer.from([0xff])]));
      const gen = kaos.readLines(filePath);
      await expect(gen.next()).resolves.toMatchObject({ value: 'ok\n', done: false });
      await expect(gen.next()).rejects.toThrow();
    });
  });

  describe('scanTextFile', () => {
    it('counts lines and classifies line endings', async () => {
      const lf = join(tempDir, 'lf.txt');
      await kaos.writeText(lf, 'a\nb');
      await expect(kaos.scanTextFile(lf)).resolves.toMatchObject({
        totalLines: 2,
        endsWithNewline: false,
        hasNul: false,
        lineEndingFlags: { hasCrLf: false, hasLf: true, hasLoneCr: false },
      });

      const crlf = join(tempDir, 'crlf.txt');
      await kaos.writeText(crlf, 'a\r\nb\r\n');
      await expect(kaos.scanTextFile(crlf)).resolves.toMatchObject({
        totalLines: 2,
        endsWithNewline: true,
        lineEndingFlags: { hasCrLf: true, hasLf: false, hasLoneCr: false },
      });

      const loneCr = join(tempDir, 'lone-cr.txt');
      await kaos.writeText(loneCr, 'a\rB\n');
      await expect(kaos.scanTextFile(loneCr)).resolves.toMatchObject({
        totalLines: 1,
        lineEndingFlags: { hasCrLf: false, hasLf: true, hasLoneCr: true },
      });
    });

    it('detects NUL and invalid UTF-8', async () => {
      const nul = join(tempDir, 'nul.txt');
      await kaos.writeBytes(nul, Buffer.from('a\u0000b\n', 'utf-8'));
      await expect(kaos.scanTextFile(nul)).resolves.toMatchObject({ hasNul: true });

      const invalid = join(tempDir, 'invalid.txt');
      await kaos.writeBytes(invalid, Buffer.from([0xff]));
      await expect(kaos.scanTextFile(invalid)).rejects.toThrow();
    });
  });

  describe('readLineRange', () => {
    async function collectRange(path: string, startLine: number, maxLines: number) {
      const lines: string[] = [];
      for await (const line of kaos.readLineRange(path, { startLine, maxLines })) {
        lines.push(line);
      }
      return lines;
    }

    it('reads only the requested line window', async () => {
      const filePath = join(tempDir, 'range.txt');
      await kaos.writeText(filePath, 'a\nb\nc\nd\n');
      await expect(collectRange(filePath, 2, 2)).resolves.toEqual(['b\n', 'c\n']);
      await expect(collectRange(filePath, 5, 2)).resolves.toEqual([]);
    });

    it('preserves U+FEFF at the start of a ranged non-first line', async () => {
      const filePath = join(tempDir, 'range-bom.txt');
      await kaos.writeText(filePath, 'a\n\uFEFFb\n');
      await expect(collectRange(filePath, 2, 1)).resolves.toEqual(['\uFEFFb\n']);
    });
  });

  describe('readTailLines', () => {
    async function collectTail(path: string, tailCount: number) {
      const lines: string[] = [];
      for await (const line of kaos.readTailLines(path, { tailCount })) {
        lines.push(line);
      }
      return lines;
    }

    it('reads last lines with and without trailing newline', async () => {
      const trailing = join(tempDir, 'tail-trailing.txt');
      await kaos.writeText(trailing, 'a\nb\nc\n');
      await expect(collectTail(trailing, 2)).resolves.toEqual(['b\n', 'c\n']);

      const noTrailing = join(tempDir, 'tail-no-trailing.txt');
      await kaos.writeText(noTrailing, 'a\nb\nc');
      await expect(collectTail(noTrailing, 2)).resolves.toEqual(['b\n', 'c']);
    });

    it('returns the whole file when tailCount exceeds line count', async () => {
      const filePath = join(tempDir, 'tail-short.txt');
      await kaos.writeText(filePath, 'a\nb\n');
      await expect(collectTail(filePath, 5)).resolves.toEqual(['a\n', 'b\n']);
    });

    it('preserves CRLF and U+FEFF in tail lines', async () => {
      const filePath = join(tempDir, 'tail-crlf-bom.txt');
      await kaos.writeText(filePath, 'a\r\n\uFEFFb\r\n');
      await expect(collectTail(filePath, 1)).resolves.toEqual(['\uFEFFb\r\n']);
    });
  });

  describe('readText errors parameter (Python compat)', () => {
    // A file with a valid UTF-8 prefix "中", an invalid standalone byte 0xff,
    // and a valid UTF-8 suffix "文". Under strict decoding this throws.
    const invalidBytes = Buffer.concat([
      Buffer.from([0xe4, 0xb8, 0xad]), // 中
      Buffer.from([0xff]),
      Buffer.from([0xe6, 0x96, 0x87]), // 文
    ]);

    it('throws on invalid utf-8 with errors="strict" (default)', async () => {
      const filePath = join(tempDir, 'invalid.txt');
      await kaos.writeBytes(filePath, invalidBytes);

      await expect(kaos.readText(filePath)).rejects.toThrow();
      await expect(kaos.readText(filePath, { errors: 'strict' })).rejects.toThrow();
    });

    it('returns U+FFFD replacement characters with errors="replace"', async () => {
      const filePath = join(tempDir, 'replace.txt');
      await kaos.writeBytes(filePath, invalidBytes);

      const content = await kaos.readText(filePath, { errors: 'replace' });
      expect(content).toContain('\uFFFD');
      expect(content).toContain('中');
      expect(content).toContain('文');
    });

    it('drops invalid bytes with errors="ignore"', async () => {
      const filePath = join(tempDir, 'ignore.txt');
      await kaos.writeBytes(filePath, invalidBytes);

      const content = await kaos.readText(filePath, { errors: 'ignore' });
      expect(content).toBe('中文');
      expect(content).not.toContain('\uFFFD');
    });

    it('preserves valid U+FFFD characters with errors="ignore"', async () => {
      const filePath = join(tempDir, 'ignore-valid-replacement.txt');
      const data = Buffer.concat([
        Buffer.from('A\uFFFDB', 'utf-8'),
        Buffer.from([0xff]),
        Buffer.from('C', 'utf-8'),
      ]);
      await kaos.writeBytes(filePath, data);

      const content = await kaos.readText(filePath, { errors: 'ignore' });
      expect(content).toBe('A\uFFFDBC');
    });
  });

  describe('LF preservation', () => {
    it('should not convert LF to CRLF', async () => {
      const filePath = join(tempDir, 'lf.txt');
      await kaos.writeText(filePath, 'hello\nworld\n');

      const raw = await kaos.readBytes(filePath);
      expect(raw).toEqual(Buffer.from('hello\nworld\n'));
    });
  });

  describe('CRLF preservation', () => {
    it('should preserve CRLF line endings', async () => {
      const filePath = join(tempDir, 'crlf.txt');
      await kaos.writeText(filePath, 'hello\r\nworld\r\n');

      const raw = await kaos.readBytes(filePath);
      expect(raw).toEqual(Buffer.from('hello\r\nworld\r\n'));
    });
  });

  describe('mkdir recursive', () => {
    it('should create nested directories with parents option', async () => {
      const nested = join(tempDir, 'a', 'b', 'c');
      await kaos.mkdir(nested, { parents: true });

      const s = await kaos.stat(nested);
      // Check it's a directory (mode has the directory bit set)
      // S_IFDIR = 0o040000
      expect(s.stMode & 0o170000).toBe(0o040000);
    });

    it('should throw when parents:true + existOk:false on existing dir', async () => {
      // Regression: fs.mkdir({ recursive: true }) silently succeeds on an
      // existing directory. mkdir({ parents: true, existOk: false }) must
      // still reject to match the advertised semantics.
      const existing = join(tempDir, 'existing');
      await kaos.mkdir(existing);

      await expect(kaos.mkdir(existing, { parents: true, existOk: false })).rejects.toThrow();
    });

    it('should succeed when parents:true + existOk:true on existing dir', async () => {
      const existing = join(tempDir, 'existing');
      await kaos.mkdir(existing);

      await expect(kaos.mkdir(existing, { parents: true, existOk: true })).resolves.toBeUndefined();
    });

    it('should throw when existOk:true but conflicting path is a file', async () => {
      // If the target path already exists as a regular file, `existOk` must
      // not silently "succeed" because there is still no directory there.
      const filePath = join(tempDir, 'not-a-dir.txt');
      await kaos.writeText(filePath, 'hello');

      await expect(kaos.mkdir(filePath, { existOk: true })).rejects.toBeInstanceOf(
        KaosFileExistsError,
      );
    });
  });

  describe('glob character class negation', () => {
    it('[!a] should match non-a files (glob negation, not literal `!`)', async () => {
      // Glob character classes use `!` for negation, unlike JavaScript regex.
      await kaos.writeText(join(tempDir, 'a.txt'), '');
      await kaos.writeText(join(tempDir, 'b.txt'), '');
      await kaos.writeText(join(tempDir, '!.txt'), '');

      const matches: string[] = [];
      for await (const m of kaos.glob(tempDir, '[!a].txt')) {
        matches.push(m);
      }
      const names = new Set(matches.map((p) => p.split(/[/\\]/).pop()!));

      expect(names.has('a.txt')).toBe(false);
      expect(names.has('b.txt')).toBe(true);
      expect(names.has('!.txt')).toBe(true);
    });
  });

  describe('glob ** pattern', () => {
    it('should not return duplicates when ** matches nested paths', async () => {
      // Regression for the `**` double-recursion bug: a single file nested
      // two levels deep must appear exactly once, not 2^depth times.
      await kaos.mkdir(join(tempDir, 'a', 'b'), { parents: true });
      await kaos.writeText(join(tempDir, 'a', 'b', 'file.txt'), 'content');

      const matches: string[] = [];
      for await (const m of kaos.glob(tempDir, '**/*.txt')) {
        matches.push(m);
      }

      expect(matches).toHaveLength(1);
      expect(new Set(matches).size).toBe(matches.length);
    });

    it('should match ** at multiple depths without duplicates', async () => {
      await kaos.mkdir(join(tempDir, 'a', 'b', 'c'), { parents: true });
      await kaos.writeText(join(tempDir, 'root.txt'), '');
      await kaos.writeText(join(tempDir, 'a', 'mid.txt'), '');
      await kaos.writeText(join(tempDir, 'a', 'b', 'c', 'deep.txt'), '');

      const matches: string[] = [];
      for await (const m of kaos.glob(tempDir, '**/*.txt')) {
        matches.push(m);
      }

      expect(matches).toHaveLength(3);
      expect(new Set(matches).size).toBe(3);
      const names = new Set(matches.map((p) => p.split(/[/\\]/).pop()!));
      expect(names).toEqual(new Set(['root.txt', 'mid.txt', 'deep.txt']));
    });

    it('should not duplicate matches for deep ** patterns', async () => {
      // Before the fix, each added depth level doubled the duplicate count.
      // Build a 4-level-deep tree with a file at the bottom.
      await kaos.mkdir(join(tempDir, 'l1', 'l2', 'l3', 'l4'), { parents: true });
      await kaos.writeText(join(tempDir, 'l1', 'l2', 'l3', 'l4', 'deep.txt'), 'x');

      const matches: string[] = [];
      for await (const m of kaos.glob(tempDir, '**/*.txt')) {
        matches.push(m);
      }

      expect(matches).toHaveLength(1);
    });

    it('should yield basePath and every recursive entry when the whole pattern is **', async () => {
      // A bare `**` pattern enters the final-segment branch of _globWalk and
      // must (a) emit basePath itself for the zero-directory match and
      // (b) walk every file/dir below it as additional matches.
      await kaos.mkdir(join(tempDir, 'sub'));
      await kaos.writeText(join(tempDir, 'root.txt'), 'r');
      await kaos.writeText(join(tempDir, 'sub', 'nested.txt'), 'n');

      const matches: string[] = [];
      for await (const m of kaos.glob(tempDir, '**')) {
        matches.push(m);
      }

      const names = new Set(matches.map((p) => p.split(/[/\\]/).pop() ?? ''));
      expect(matches).toContain(tempDir);
      expect(names.has('root.txt')).toBe(true);
      expect(names.has('nested.txt')).toBe(true);
      expect(names.has('sub')).toBe(true);
    });
  });

  // ── Symlink cycle safety ────────────────────────────────────────────
  //
  // These tests use real filesystem symlinks. Note: macOS/Linux apply
  // SYMLOOP_MAX (~40 components) at the kernel level, so an unfixed
  // walker doesn't hang forever — it yields a bounded-but-large number
  // of cyclic paths (observed ~16 for a self-loop) before ELOOP. The
  // assertions here are therefore tight (single-digit expected counts)
  // so they distinguish "OS-ELOOP bailout" (buggy) from "app-level
  // cycle detection" (fixed). HARD_STOP is a final safety belt in case
  // a future kernel allows deeper symlink chains — tests shouldn't hang.
  describe('glob symlink cycle safety', () => {
    const HARD_STOP = 1000;

    it('T-C1 self-symlink cycle yields exactly one match', async () => {
      const { symlink, writeFile, mkdir } = await import('node:fs/promises');
      // tempDir/ring/self → tempDir/ring (self-loop dir)
      // tempDir/ring/leaf.txt (the only real file)
      const ring = join(tempDir, 'ring');
      await mkdir(ring);
      await writeFile(join(ring, 'leaf.txt'), 'real');
      await symlink(ring, join(ring, 'self'));

      const matches: string[] = [];
      for await (const m of kaos.glob(tempDir, '**/*.txt')) {
        matches.push(m);
        if (matches.length >= HARD_STOP) break;
      }
      // Fixed: visited-inode detects the self-loop on the first recurse
      // into `ring/self` (whose resolved inode matches `ring`'s), so the
      // walker yields `ring/leaf.txt` exactly once.
      // Unfixed: ~16 copies like `ring/self/self/.../leaf.txt` before
      // the kernel's SYMLOOP_MAX trips.
      expect(matches).toHaveLength(1);
      expect(matches[0]!.endsWith('leaf.txt')).toBe(true);
    });

    it('T-C2 mutual cycle (A/to_b→B, B/to_a→A) yields only finite real reaches', async () => {
      const { symlink, writeFile, mkdir } = await import('node:fs/promises');
      const a = join(tempDir, 'A');
      const b = join(tempDir, 'B');
      await mkdir(a);
      await mkdir(b);
      await writeFile(join(a, 'aleaf.txt'), 'a');
      await writeFile(join(b, 'bleaf.txt'), 'b');
      await symlink(b, join(a, 'to_b'));
      await symlink(a, join(b, 'to_a'));

      const matches: string[] = [];
      for await (const m of kaos.glob(tempDir, '**/*.txt')) {
        matches.push(m);
        if (matches.length >= HARD_STOP) break;
      }
      // Fixed: path-local visited allows each legitimate descent (A→to_b
      // which hits a fresh B, and B→to_a which hits a fresh A) but
      // blocks the close-the-loop second step. Expected exactly 4:
      //   root/A/aleaf.txt, root/A/to_b/bleaf.txt,
      //   root/B/bleaf.txt, root/B/to_a/aleaf.txt.
      // Unfixed: kernel ELOOP bailout yields many more (observed ~66
      // on macOS). A shared-visited (non-path-local) impl would yield
      // only 2 because entering B from the walker's root already marks
      // B as visited before A→to_b is traversed.
      expect(matches).toHaveLength(4);
      expect(matches.filter((p) => p.endsWith('aleaf.txt'))).toHaveLength(2);
      expect(matches.filter((p) => p.endsWith('bleaf.txt'))).toHaveLength(2);
    });

    it('T-C3 legit non-cyclic symlink to a sibling tree is followed', async () => {
      const { symlink, writeFile, mkdir } = await import('node:fs/promises');
      // target/ is a sibling not under root/, reached only via root/shortcut.
      const root = join(tempDir, 'root');
      const target = join(tempDir, 'target');
      await mkdir(root);
      await mkdir(target);
      await writeFile(join(target, 'reachable.txt'), 'hi');
      await symlink(target, join(root, 'shortcut'));

      const matches: string[] = [];
      for await (const m of kaos.glob(root, '**/*.txt')) {
        matches.push(m);
      }
      // User-created symlinks to legitimate subtrees should still be followed;
      // cycle detection only trips on actual cycles.
      expect(matches.some((p) => p.endsWith('reachable.txt'))).toBe(true);
    });

    it('T-C4 broken symlink does not crash the walk', async () => {
      const { symlink, writeFile, mkdir } = await import('node:fs/promises');
      const root = join(tempDir, 'broken-root');
      await mkdir(root);
      await writeFile(join(root, 'real.txt'), 'r');
      // Points at a path that doesn't exist.
      await symlink(join(tempDir, 'does-not-exist'), join(root, 'dangling'));

      const matches: string[] = [];
      // Pattern must not match "dangling" (no .txt); we want the real
      // file yielded and the walker to not throw on the broken symlink
      // (whose stat() rejects).
      for await (const m of kaos.glob(root, '**/*.txt')) {
        matches.push(m);
      }
      expect(matches.some((p) => p.endsWith('real.txt'))).toBe(true);
    });

    it('T-C5 regression — non-symlink tree results are unchanged', async () => {
      // Plain, non-symlink trees should not be filtered by cycle tracking.
      await kaos.mkdir(join(tempDir, 'a', 'b', 'c'), { parents: true });
      await kaos.writeText(join(tempDir, 'r1.txt'), '');
      await kaos.writeText(join(tempDir, 'a', 'r2.txt'), '');
      await kaos.writeText(join(tempDir, 'a', 'b', 'c', 'r3.txt'), '');

      const matches: string[] = [];
      for await (const m of kaos.glob(tempDir, '**/*.txt')) {
        matches.push(m);
      }
      expect(matches).toHaveLength(3);
      const names = new Set(matches.map((p) => p.split(/[/\\]/).pop()!));
      expect(names).toEqual(new Set(['r1.txt', 'r2.txt', 'r3.txt']));
    });

    it('T-C6 two non-cyclic symlinks to same target both traverse (path-local visited)', async () => {
      const { symlink, writeFile, mkdir } = await import('node:fs/promises');
      // root/a → target, root/b → target. Both are legitimate (not
      // cycles) — the user deliberately aliased the target twice.
      const root = join(tempDir, 'root-aliases');
      const target = join(tempDir, 'aliased-target');
      await mkdir(root);
      await mkdir(target);
      await writeFile(join(target, 'shared.txt'), 'x');
      await symlink(target, join(root, 'a'));
      await symlink(target, join(root, 'b'));

      const matches: string[] = [];
      for await (const m of kaos.glob(root, '**/*.txt')) {
        matches.push(m);
      }
      // Each alias branch has its own visited set copy, so both aliased paths
      // surface. A shared visited set would yield only one of them.
      expect(matches.some((p) => p.endsWith(`a/shared.txt`) || p.endsWith(`a\\shared.txt`))).toBe(
        true,
      );
      expect(matches.some((p) => p.endsWith(`b/shared.txt`) || p.endsWith(`b\\shared.txt`))).toBe(
        true,
      );
    });
  });

  describe('readBytes/writeBytes', () => {
    it('should round-trip binary data', async () => {
      const filePath = join(tempDir, 'data.bin');
      const data = Buffer.from([0x00, 0x01, 0x02, 0xff]);

      const written = await kaos.writeBytes(filePath, data);
      expect(written).toBe(4);

      const read = await kaos.readBytes(filePath);
      expect(Buffer.compare(read, data)).toBe(0);
    });
  });

  describe('exec streaming', () => {
    it('should run a command and stream stdout/stderr', async () => {
      const code = `process.stdout.write('hello\\n'); process.stderr.write('stderr line\\n');`;
      const proc = await kaos.exec(...nodeArgs(code));

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      const stdoutDone = new Promise<void>((resolve) => {
        proc.stdout.on('data', (chunk: Buffer) => {
          stdoutChunks.push(chunk);
        });
        proc.stdout.on('end', () => {
          resolve();
        });
      });

      const stderrDone = new Promise<void>((resolve) => {
        proc.stderr.on('data', (chunk: Buffer) => {
          stderrChunks.push(chunk);
        });
        proc.stderr.on('end', () => {
          resolve();
        });
      });

      const exitCode = await proc.wait();
      await stdoutDone;
      await stderrDone;

      expect(exitCode).toBe(0);
      expect(Buffer.concat(stdoutChunks).toString('utf-8').trim()).toBe('hello');
      expect(Buffer.concat(stderrChunks).toString('utf-8').trim()).toBe('stderr line');
    });
  });

  describe('exec wait-before-read', () => {
    it('should buffer output and allow reading after wait', async () => {
      const code = `process.stdout.write('hello\\n'); process.stderr.write('stderr line\\n');`;
      const proc = await kaos.exec(...nodeArgs(code));

      const exitCode = await proc.wait();
      expect(exitCode).toBe(0);

      // Read streams after process has already exited
      const stdoutData = await streamToBuffer(proc.stdout);
      const stderrData = await streamToBuffer(proc.stderr);

      expect(stdoutData.toString('utf-8').trim()).toBe('hello');
      expect(stderrData.toString('utf-8').trim()).toBe('stderr line');
    });
  });

  describe('exec non-zero exit', () => {
    it('should return the correct exit code', async () => {
      const proc = await kaos.exec(...nodeArgs('process.exit(7)'));
      const exitCode = await proc.wait();
      expect(exitCode).toBe(7);
      expect(proc.exitCode).toBe(7);
    });
  });

  describe('exec spawn failure', () => {
    it('should reject when the binary does not exist', async () => {
      await expect(kaos.exec('/absolutely/non-existent/binary')).rejects.toThrow();
    });

    it('should reject exec() with no arguments', async () => {
      // exec(...args) requires at least one argument (the command name).
      // Cast through the loose signature so the call even compiles.
      await expect((kaos.exec as () => Promise<unknown>)()).rejects.toThrow(
        /at least one argument/,
      );
    });

    it('should reject execWithEnv() with an empty args array', async () => {
      // Mirrors the exec() guard: execWithEnv must also demand at least
      // one argument (the command itself).
      await expect(kaos.execWithEnv([])).rejects.toThrow(/at least one argument/);
    });
  });

  describe('exec timeout', () => {
    it('dispose destroys process stdio without killing the process', async () => {
      const proc = await kaos.exec(...nodeArgs('setTimeout(() => {}, 10000);'));

      await proc.dispose();
      await proc.dispose();

      expect(proc.exitCode).toBeNull();
      expect(proc.stdout.destroyed).toBe(true);
      expect(proc.stderr.destroyed).toBe(true);

      await proc.kill('SIGKILL');
      await proc.wait();
    });

    it('should allow killing a long-running process', async () => {
      const code = `setTimeout(() => {}, 10000);`;
      const proc = await kaos.exec(...nodeArgs(code));

      expect(proc.pid).toBeGreaterThan(0);

      // Use a short timeout via Promise.race
      const result = await Promise.race([
        proc.wait().then((exitCode) => ({ kind: 'exited' as const, code: exitCode })),
        new Promise<{ kind: 'timeout' }>((resolve) =>
          setTimeout(() => {
            resolve({ kind: 'timeout' });
          }, 50),
        ),
      ]);

      expect(result.kind).toBe('timeout');

      // Kill the process
      await proc.kill('SIGKILL');
      const exitCode = await proc.wait();
      // On Unix, killed processes typically have negative exit or 137
      expect(exitCode).not.toBe(0);
    });
  });

  describe('withEnv', () => {
    it('overlays every spawned process and can be updated in place', async () => {
      const env = {
        KAOS_BASE_ENV: 'initial',
        KAOS_COLLISION_ENV: 'configured',
      };
      const envKaos = kaos.withEnv(env);
      const printEnv =
        'process.stdout.write(`${process.env.KAOS_BASE_ENV}|${process.env.KAOS_COLLISION_ENV}|${process.env.KAOS_CALL_ENV}`)';

      const first = await envKaos.exec('node', '-e', printEnv);
      expect(await first.wait()).toBe(0);
      expect((await streamToBuffer(first.stdout)).toString('utf-8')).toBe('initial|configured|undefined');

      const second = await envKaos.execWithEnv(['node', '-e', printEnv], {
        ...(process.env as Record<string, string>),
        KAOS_COLLISION_ENV: 'host',
        KAOS_CALL_ENV: 'call',
      });
      expect(await second.wait()).toBe(0);
      expect((await streamToBuffer(second.stdout)).toString('utf-8')).toBe('initial|configured|call');

      env.KAOS_BASE_ENV = 'updated';
      const third = await envKaos.exec('node', '-e', printEnv);
      expect(await third.wait()).toBe(0);
      expect((await streamToBuffer(third.stdout)).toString('utf-8')).toBe('updated|configured|undefined');
    });
  });
});

describe('LocalKaos instance isolation', () => {
  test('instances have isolated cwds (no process.cwd pollution)', async () => {
    const kaosA = await LocalKaos.create();
    const kaosB = await LocalKaos.create();

    const tmpA = toPosix(await realpath(await mkdtemp(join(tmpdir(), 'kaos-a-'))));
    const tmpB = toPosix(await realpath(await mkdtemp(join(tmpdir(), 'kaos-b-'))));

    try {
      await kaosA.chdir(tmpA);
      await kaosB.chdir(tmpB);

      // kaosA.chdir must not affect kaosB's cwd (no process.chdir pollution).
      expect(kaosA.getcwd()).toBe(tmpA);
      expect(kaosB.getcwd()).toBe(tmpB);

      // Write a file named "marker.txt" in each cwd using a relative path.
      await kaosA.writeText('marker.txt', 'A');
      await kaosB.writeText('marker.txt', 'B');

      // Read back via each kaos — each should get its own version.
      expect(await kaosA.readText('marker.txt')).toBe('A');
      expect(await kaosB.readText('marker.txt')).toBe('B');

      // exec() should also honour the instance cwd.
      const procA = await kaosA.exec('node', '-e', 'process.stdout.write(process.cwd())');
      const procB = await kaosB.exec('node', '-e', 'process.stdout.write(process.cwd())');
      await procA.wait();
      await procB.wait();
      const outA = await streamToBuffer(procA.stdout);
      const outB = await streamToBuffer(procB.stdout);
      expect(toPosix(outA.toString('utf-8'))).toBe(tmpA);
      expect(toPosix(outB.toString('utf-8'))).toBe(tmpB);
    } finally {
      await rm(tmpA, { recursive: true, force: true });
      await rm(tmpB, { recursive: true, force: true });
    }
  });
});

describe('LocalProcess.kill safety', () => {
  test('kill() is safe when spawn failed (pid -1 must not signal process group)', async () => {
    const kaos = await LocalKaos.create();

    // Try to spawn a nonexistent command. Node's spawn() returns a
    // ChildProcess immediately with pid=undefined; the "error" event
    // arrives asynchronously.
    let proc;
    try {
      proc = await kaos.exec('this-command-does-not-exist-xyz123');
    } catch {
      // If the environment threw synchronously, there's nothing to kill.
      return;
    }

    // If pid is -1, kill must be a no-op and must NOT call
    // process.kill(-1, ...) which would signal the entire process group.
    if (proc.pid <= 0) {
      await expect(proc.kill('SIGTERM')).resolves.toBeUndefined();
    }

    // Drain error event so the test runner doesn't leak unhandled errors.
    try {
      await proc.wait();
    } catch {
      // Expected for nonexistent commands.
    }
  });

  test('kill() handles already-exited process gracefully (ESRCH ignored)', async () => {
    const kaos = await LocalKaos.create();
    const proc = await kaos.exec('node', '-e', 'process.exit(0)');
    await proc.wait();

    // Calling kill after exit should not throw — ESRCH is ignored.
    await expect(proc.kill('SIGTERM')).resolves.toBeUndefined();
  });

  // ── Windows process-tree kill ───────────────────────────────────────
  //
  // On Windows the Node default kills only the shell parent; grandchildren can
  // leak and run beyond the two-phase kill grace window.
  //
  // This test boots a nested process chain (parent → child → grandchild)
  // and asserts that `proc.kill('SIGTERM')` tears the whole tree down.
  // The grandchild is probed via its pidfile: if the file still names a
  // live pid after the kill, the tree leaked.
  test.skipIf(process.platform !== 'win32')(
    'kill() terminates the grandchild on Windows (process tree)',
    async () => {
      const kaos = await LocalKaos.create();
      const tmp = await realpath(await mkdtemp(join(tmpdir(), 'kaos-killtree-')));
      try {
        // Run the parent → child → grandchild chain from a real script file
        // (see test/fixtures/killtree.cjs) with the pidfile path passed via
        // argv. Inline multi-line `node -e` strings get mangled on Windows by
        // Node's arg-quoting and by JS string escapes, so the pidfile was
        // never written and the test read ENOENT.
        const pidPath = join(tmp, 'grandchild.pid');
        const scriptPath = fileURLToPath(new URL('./fixtures/killtree.cjs', import.meta.url));
        const proc = await kaos.exec('node', scriptPath, pidPath);
        const start = Date.now();
        while (Date.now() - start < 5000) {
          try {
            if ((await stat(pidPath)).isFile()) break;
          } catch {
            /* not yet */
          }
          await new Promise((r) => setTimeout(r, 50));
        }
        const grandchildPid = Number.parseInt((await readFile(pidPath, 'utf-8')).trim(), 10);
        expect(Number.isNaN(grandchildPid)).toBe(false);

        // Kill parent — on Windows this currently leaks the grandchild
        // unless `taskkill /T /F` (or equivalent) is used.
        await proc.kill('SIGTERM');
        await proc.wait();

        // Give the OS up to 2s to reap the grandchild.
        const reaped = await (async (): Promise<boolean> => {
          for (let i = 0; i < 40; i += 1) {
            try {
              process.kill(grandchildPid, 0); // "is it still alive?"
            } catch {
              return true; // ESRCH — grandchild gone
            }
            await new Promise((r) => setTimeout(r, 50));
          }
          return false;
        })();

        expect(reaped).toBe(true);
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    },
    30_000,
  );

  // ── POSIX process-group kill ────────────────────────────────────────
  //
  // Structure mirrors the Windows grandchild test above: a Node parent
  // spawns a child that spawns a long-running grandchild and writes its
  // pid to a file. After `proc.kill('SIGTERM')`, the grandchild must
  // be gone within a generous (~2 s) reap window.
  test.skipIf(process.platform === 'win32')(
    'kill() terminates the grandchild on POSIX (process tree)',
    async () => {
      const kaos = await LocalKaos.create();
      const tmp = await realpath(await mkdtemp(join(tmpdir(), 'kaos-killtree-posix-')));
      try {
        const pidFile = join(tmp, 'grandchild.pid');
        // `exec('bash', '-c', …)` spawns bash as the direct child; the
        // embedded node chain spawns a long-running grandchild under it.
        // The grandchild writes its pid so we can poll liveness.
        const script = `
          node -e 'const { spawn } = require("node:child_process");
            const { writeFileSync } = require("node:fs");
            const g = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
            writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
            setInterval(() => {}, 1000);'
        `;
        const proc = await kaos.exec('bash', '-c', script);

        const { stat, readFile } = await import('node:fs/promises');
        const start = Date.now();
        while (Date.now() - start < 5000) {
          try {
            if ((await stat(pidFile)).isFile()) break;
          } catch {
            /* not yet */
          }
          await new Promise((r) => setTimeout(r, 50));
        }
        const grandchildPid = Number.parseInt((await readFile(pidFile, 'utf-8')).trim(), 10);
        expect(Number.isNaN(grandchildPid)).toBe(false);

        await proc.kill('SIGTERM');
        await proc.wait();

        const reaped = await (async (): Promise<boolean> => {
          for (let i = 0; i < 40; i += 1) {
            try {
              process.kill(grandchildPid, 0);
            } catch {
              return true;
            }
            await new Promise((r) => setTimeout(r, 50));
          }
          return false;
        })();

        expect(reaped).toBe(true);
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks);
}

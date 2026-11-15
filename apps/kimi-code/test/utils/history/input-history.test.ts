import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, it, expect } from 'vitest';

import { loadInputHistory, appendInputHistory } from '#/utils/history/input-history';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'input-history-'));
  file = join(dir, 'history.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('input-history', () => {
  it('returns empty when file does not exist', async () => {
    expect(await loadInputHistory(file)).toEqual([]);
  });

  it('parses valid jsonl entries in order', async () => {
    writeFileSync(
      file,
      [
        JSON.stringify({ content: 'first' }),
        JSON.stringify({ content: 'second' }),
        '',
        JSON.stringify({ content: 'third' }),
      ].join('\n'),
      'utf-8',
    );
    const entries = await loadInputHistory(file);
    expect(entries).toEqual([{ content: 'first' }, { content: 'second' }, { content: 'third' }]);
  });

  it('skips malformed lines without aborting the load', async () => {
    writeFileSync(
      file,
      [
        JSON.stringify({ content: 'good' }),
        'not json',
        JSON.stringify({ wrong_field: 'x' }),
        JSON.stringify({ content: 'tail' }),
      ].join('\n'),
      'utf-8',
    );
    const entries = await loadInputHistory(file);
    expect(entries).toEqual([{ content: 'good' }, { content: 'tail' }]);
  });

  it('appends a new entry and creates the parent directory', async () => {
    const nested = join(dir, 'nested', 'sub', 'history.jsonl');
    const written = await appendInputHistory(nested, { content: 'hello' });
    expect(written).toBe(true);
    const raw = readFileSync(nested, 'utf-8').trim().split('\n');
    expect(raw).toHaveLength(1);
    expect(JSON.parse(raw[0]!)).toEqual({ content: 'hello' });
  });

  it('skips empty / whitespace-only entries', async () => {
    expect(await appendInputHistory(file, { content: '' })).toBe(false);
    expect(await appendInputHistory(file, { content: '   ' })).toBe(false);
    expect(await loadInputHistory(file)).toEqual([]);
  });

  it('skips when the complete entry equals the previous entry', async () => {
    expect(await appendInputHistory(file, { content: 'a' })).toBe(true);
    expect(await appendInputHistory(file, { content: 'a' }, { content: 'a' })).toBe(false);
    expect(await appendInputHistory(file, { content: 'b' }, { content: 'a' })).toBe(true);
    const entries = await loadInputHistory(file);
    expect(entries).toEqual([{ content: 'a' }, { content: 'b' }]);
  });

  it('trims whitespace before persisting', async () => {
    expect(await appendInputHistory(file, { content: '  hi  ' })).toBe(true);
    const entries = await loadInputHistory(file);
    expect(entries).toEqual([{ content: 'hi' }]);
  });

  it('persists selected skill paths without deduplicating different variants', async () => {
    const first = {
      content: '/skill:review',
      inlineSkillActivations: [{
        skillName: 'review',
        path: '/work/A/review/SKILL.md',
        start: 0,
        occurrences: [{ commandName: 'skill:review', start: 0 }],
      }],
    };
    const second = {
      ...first,
      inlineSkillActivations: [{
        skillName: 'review',
        path: '/work/B/review/SKILL.md',
        start: 0,
        occurrences: [{ commandName: 'skill:review', start: 0 }],
      }],
    };

    expect(await appendInputHistory(file, first)).toBe(true);
    expect(await appendInputHistory(file, first, first)).toBe(false);
    expect(await appendInputHistory(file, second, first)).toBe(true);
    expect(await loadInputHistory(file)).toEqual([first, second]);
  });

  it('deduplicates reloaded entries with optional fields omitted', async () => {
    const entry = {
      content: '/skill:review src/app.ts',
      inlineSkillActivations: [{
        skillName: 'review',
        path: undefined,
        start: 0,
        args: 'src/app.ts',
      }],
    };
    expect(await appendInputHistory(file, entry)).toBe(true);
    const [persisted] = await loadInputHistory(file);

    expect(await appendInputHistory(file, entry, persisted)).toBe(false);
  });
});

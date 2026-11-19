import { describe, expect, it, vi } from 'vitest';
import { fontMetadataText, parseFontNames, readFontMetadata } from '../src/lib/fontMetadata';

type NameInput = { id: number; text: string; language?: number; platform?: number; encoding?: number };
function names(records: NameInput[], tags: string[] = []): Buffer {
  const strings = records.map((r) => Buffer.from(r.text, 'utf16le').swap16());
  const languages = tags.map((tag) => Buffer.from(tag, 'utf16le').swap16());
  const start = 6 + records.length * 12 + (tags.length ? 2 + tags.length * 4 : 0);
  const result = Buffer.alloc(start + [...strings, ...languages].reduce((n, s) => n + s.length, 0));
  result.writeUInt16BE(tags.length ? 1 : 0, 0);
  result.writeUInt16BE(records.length, 2);
  result.writeUInt16BE(start, 4);
  let cursor = 0;
  records.forEach((r, i) => {
    const p = 6 + i * 12;
    [r.platform ?? 3, r.encoding ?? 1, r.language ?? 0x409, r.id, strings[i]!.length, cursor].forEach((n, j) => result.writeUInt16BE(n, p + j * 2));
    strings[i]!.copy(result, start + cursor);
    cursor += strings[i]!.length;
  });
  if (tags.length) {
    const p = 6 + records.length * 12;
    result.writeUInt16BE(tags.length, p);
    languages.forEach((tag, i) => {
      result.writeUInt16BE(tag.length, p + 2 + i * 4);
      result.writeUInt16BE(cursor, p + 4 + i * 4);
      tag.copy(result, start + cursor);
      cursor += tag.length;
    });
  }
  return result;
}

function sfnt(tables: Record<string, Buffer>, base = 0): Buffer {
  const entries = Object.entries(tables);
  let offset = 12 + entries.length * 16;
  const result = Buffer.alloc(offset + entries.reduce((n, [, table]) => n + table.length, 0));
  result.writeUInt32BE(0x00010000, 0);
  result.writeUInt16BE(entries.length, 4);
  entries.forEach(([tag, table], i) => {
    result.write(tag, 12 + i * 16, 4, 'ascii');
    result.writeUInt32BE(base + offset, 20 + i * 16);
    result.writeUInt32BE(table.length, 24 + i * 16);
    table.copy(result, offset);
    offset += table.length;
  });
  return result;
}

const bytes = (buffer: Buffer) => Uint8Array.from(buffer).buffer;
const blob = (buffer: Buffer) => new Blob([bytes(buffer)]);

describe('font metadata', () => {
  it('prefers localized names without changing the family identity and reads sample text', async () => {
    const metadata = await readFontMetadata(blob(sfnt({ name: names([
      { id: 16, text: 'PingFang SC' },
      { id: 1, text: '苹方-简', language: 0x804 },
      { id: 19, text: '天地玄黄 0123', language: 0x804 },
      { id: 19, text: 'The quick brown fox' },
    ]) })));
    expect(fontMetadataText(metadata, 'zh', 'name')).toBe('苹方-简');
    expect(fontMetadataText(metadata, 'en', 'name')).toBe('PingFang SC');
    expect(fontMetadataText(metadata, 'zh-CN', 'sample')).toBe('天地玄黄 0123');
    expect(fontMetadataText(metadata, 'en', 'sample')).toBe('The quick brown fox');
  });

  it('reads format 1 language tags and keeps simplified and traditional names distinct', () => {
    const records = parseFontNames(bytes(names([
      { id: 1, text: '简体名称', language: 0x8000 },
      { id: 1, text: '繁體名稱', language: 0x8001 },
      { id: 1, text: 'Ignored', language: 0x8002 },
    ], ['zh-Hans', 'zh-Hant'])));
    expect(records).toHaveLength(2);
    expect(fontMetadataText({ names: records }, 'zh-TW', 'name')).toBe('繁體名稱');
    expect(fontMetadataText({ names: records }, 'zh', 'name')).toBe('简体名称');
  });

  it('returns no invented sample', async () => {
    const metadata = await readFontMetadata(blob(sfnt({ name: names([{ id: 1, text: 'Test Font' }]) })));
    expect(fontMetadataText(metadata, 'zh', 'sample')).toBe('');
  });

  it('selects the requested face in a collection rather than the first face', async () => {
    const first = sfnt({ name: names([{ id: 6, text: 'First' }, { id: 1, text: 'Wrong face' }]) }, 20);
    const second = sfnt({ name: names([{ id: 6, text: 'Second' }, { id: 1, text: 'Correct face' }]) }, 20 + first.length);
    const header = Buffer.alloc(20);
    header.write('ttcf'); header.writeUInt32BE(0x00010000, 4); header.writeUInt32BE(2, 8);
    header.writeUInt32BE(20, 12); header.writeUInt32BE(20 + first.length, 16);
    const collection = blob(Buffer.concat([header, first, second]));
    expect(fontMetadataText(await readFontMetadata(collection, 'Second'), 'en', 'name')).toBe('Correct face');
    await expect(readFontMetadata(collection, 'Missing')).rejects.toThrow('not found');
    await expect(readFontMetadata(collection)).rejects.toThrow('required');
  });

  it('rejects truncated bounds and skips malformed strings', async () => {
    expect(parseFontNames(new ArrayBuffer(2))).toEqual([]);
    const name = names([{ id: 1, text: 'Broken' }]);
    name.writeUInt16BE(65535, 16);
    expect(parseFontNames(bytes(name))).toEqual([]);
    await expect(readFontMetadata(new Blob([new Uint8Array(3)]))).rejects.toThrow('bounds');
    const invalid = sfnt({ name: names([{ id: 1, text: 'Bad offset' }]) }); invalid.writeUInt32BE(0xffffffff, 20);
    await expect(readFontMetadata(blob(invalid))).rejects.toThrow('bounds');
  });

  it('reads metadata slices without transferring outline data into JavaScript', async () => {
    const file = blob(sfnt({ name: names([{ id: 1, text: 'Large font' }]), glyf: Buffer.alloc(1024 * 1024) }));
    const slice = vi.spyOn(file, 'slice');
    await readFontMetadata(file);
    const total = slice.mock.calls.reduce((sum, [start, end]) => sum + (end ?? 0) - (start ?? 0), 0);
    expect(total).toBeLessThan(1024);
  });
});

export interface FontNameRecord {
  id: number;
  language: string;
  text: string;
}

export interface FontMetadata {
  names: FontNameRecord[];
}

function languageOf(platform: number, id: number): string {
  if (platform === 3) {
    if ([0x0804, 0x1004].includes(id)) return 'zh-Hans';
    if ([0x0404, 0x0c04, 0x1404].includes(id)) return 'zh-Hant';
    const languages: Record<number, string> = { 9: 'en', 17: 'ja', 18: 'ko', 7: 'de', 12: 'fr', 10: 'es', 16: 'it', 25: 'ru', 1: 'ar' };
    return languages[id & 0x3ff] ?? 'und';
  }
  if (platform === 1) {
    return ({ 0: 'en', 1: 'fr', 2: 'de', 11: 'ja', 19: 'zh-Hant', 23: 'ko', 33: 'zh-Hans' } as Record<number, string>)[id] ?? 'und';
  }
  return 'und';
}

export function parseFontNames(buffer: ArrayBuffer): FontNameRecord[] {
  const view = new DataView(buffer);
  if (view.byteLength < 6) return [];
  const format = view.getUint16(0);
  if (format > 1) return [];
  const count = view.getUint16(2);
  const storage = view.getUint16(4);
  if (6 + count * 12 > storage || storage > view.byteLength) return [];
  const decode = (offset: number, length: number, encoding: string): string => {
    if (offset < storage || offset + length > view.byteLength) return '';
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(buffer.slice(offset, offset + length))
        .replace(/\s+/gu, ' ').replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, '').trim();
    } catch {
      return '';
    }
  };
  const tags: string[] = [];
  const tagStart = 6 + count * 12;
  if (format === 1 && tagStart + 2 <= view.byteLength) {
    const tagCount = view.getUint16(tagStart);
    if (tagStart + 2 + tagCount * 4 > storage) return [];
    for (let i = 0; i < tagCount; i++) {
      const p = tagStart + 2 + i * 4;
      tags.push(decode(storage + view.getUint16(p + 2), view.getUint16(p), 'utf-16be'));
    }
  }
  const names: FontNameRecord[] = [];
  for (let i = 0; i < count; i++) {
    const p = 6 + i * 12;
    const platform = view.getUint16(p);
    const encodingId = view.getUint16(p + 2);
    const languageId = view.getUint16(p + 4);
    const id = view.getUint16(p + 6);
    if (![1, 6, 16, 19].includes(id)) continue;
    const language = languageId >= 0x8000 ? tags[languageId - 0x8000] : languageOf(platform, languageId);
    if (!language) continue;
    const legacyEncodings: Record<number, string> = { 0: 'macintosh', 1: 'shift_jis', 2: 'big5', 3: 'euc-kr', 25: 'gb18030' };
    const encoding = platform === 0 || (platform === 3 && [0, 1, 10].includes(encodingId))
      ? 'utf-16be' : platform === 1 ? legacyEncodings[encodingId] : undefined;
    if (!encoding) continue;
    const text = decode(storage + view.getUint16(p + 10), view.getUint16(p + 8), encoding);
    if (text) names.push({ id, language, text: text.slice(0, id === 19 ? 240 : 160) });
  }
  return names;
}

function localeScore(language: string, locale: string): number {
  const wanted = locale.toLowerCase().replace(/_/g, '-');
  const candidate = language.toLowerCase();
  if (candidate === wanted) return 100;
  if (wanted.startsWith('zh')) {
    const script = /hant|tw|hk|mo/.test(wanted) ? 'hant' : 'hans';
    if (candidate.includes(script)) return 95;
  }
  if (candidate.split('-')[0] === wanted.split('-')[0]) return 80;
  if (candidate.startsWith('en')) return 20;
  if (candidate === 'und') return 10;
  return 0;
}

export function fontMetadataText(metadata: FontMetadata | undefined, locale: string, kind: 'name' | 'sample'): string {
  const ids = kind === 'sample' ? [19] : [16, 1];
  return metadata?.names.filter((record) => ids.includes(record.id)).sort((a, b) =>
    localeScore(b.language, locale) - localeScore(a.language, locale) || ids.indexOf(a.id) - ids.indexOf(b.id),
  )[0]?.text ?? '';
}

export async function readFontMetadata(blob: Blob, postscriptName?: string): Promise<FontMetadata> {
  async function read(offset: number, length: number): Promise<ArrayBuffer> {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > blob.size) {
      throw new Error('Invalid font table bounds');
    }
    return blob.slice(offset, offset + length).arrayBuffer();
  }
  const header = new DataView(await read(0, 12));
  let offsets = [0];
  if (header.getUint32(0) === 0x74746366) {
    const count = header.getUint32(8);
    if (count === 0 || count > 1024) throw new Error('Invalid font collection');
    const entries = new DataView(await read(12, count * 4));
    offsets = Array.from({ length: count }, (_, i) => entries.getUint32(i * 4));
    if (!postscriptName && count > 1) throw new Error('Font collection face is required');
  }
  for (const offset of offsets) {
    const face = new DataView(await read(offset, 12));
    if (![0x00010000, 0x4f54544f, 0x74727565].includes(face.getUint32(0))) throw new Error('Unsupported font container');
    const count = face.getUint16(4);
    const entries = new DataView(await read(offset + 12, count * 16));
    const tables: Record<string, { offset: number; length: number }> = {};
    for (let i = 0; i < count; i++) {
      const p = i * 16;
      const tag = String.fromCharCode(...[0, 1, 2, 3].map((n) => entries.getUint8(p + n)));
      tables[tag] = { offset: entries.getUint32(p + 8), length: entries.getUint32(p + 12) };
    }
    const name = tables['name'];
    if (!name || name.length > 2 * 1024 * 1024) throw new Error('Invalid font name table');
    const names = parseFontNames(await read(name.offset, name.length));
    if (offsets.length > 1 && !names.some((record) => record.id === 6 && record.text === postscriptName)) continue;
    return { names };
  }
  throw new Error('Font collection face not found');
}

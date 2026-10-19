import { describe, expect, it } from 'vitest';
import { mergeLegacyMetadata } from '../../src/sessions/source.js';

describe('mergeLegacyMetadata', () => {
  it('fills a missing custom title from metadata, skipping "Untitled"', () => {
    expect(mergeLegacyMetadata({}, { title: 'Legacy Title' }).custom_title).toBe('Legacy Title');
    expect(
      mergeLegacyMetadata({ custom_title: null }, { title: 'Untitled' }).custom_title,
    ).toBe(null);
    expect(mergeLegacyMetadata({}, { title: 'Untitled' }).custom_title).toBeUndefined();
  });

  it('keeps the state.json title when both exist', () => {
    expect(
      mergeLegacyMetadata({ custom_title: 'State Title' }, { title: 'Legacy Title' }).custom_title,
    ).toBe('State Title');
  });

  it('fills archive fields only while state holds defaults', () => {
    const merged = mergeLegacyMetadata(
      { archived: false, archived_at: null, auto_archive_exempt: false },
      { archived: true, archived_at: 9999, auto_archive_exempt: true },
    );
    expect(merged).toMatchObject({ archived: true, archived_at: 9999, auto_archive_exempt: true });

    const kept = mergeLegacyMetadata(
      { archived: true, archived_at: 1 },
      { archived: false, archived_at: 9999 },
    );
    expect(kept).toMatchObject({ archived: true, archived_at: 1 });
  });

  it('fills wire_mtime only when state has none', () => {
    expect(mergeLegacyMetadata({}, { wire_mtime: 1234.5 }).wire_mtime).toBe(1234.5);
    expect(mergeLegacyMetadata({ wire_mtime: 1 }, { wire_mtime: 1234.5 }).wire_mtime).toBe(1);
    expect(mergeLegacyMetadata({ wire_mtime: null }, { wire_mtime: 1234.5 }).wire_mtime).toBe(
      1234.5,
    );
  });

  it('fills title-generation counters only while at defaults', () => {
    const merged = mergeLegacyMetadata({}, { title_generated: true, title_generate_attempts: 2 });
    expect(merged).toMatchObject({ title_generated: true, title_generate_attempts: 2 });
    const kept = mergeLegacyMetadata(
      { title_generated: false, title_generate_attempts: 1 },
      { title_generated: true, title_generate_attempts: 2 },
    );
    expect(kept).toMatchObject({ title_generated: true, title_generate_attempts: 1 });
  });
});
